# Certificates Feature Update Plan

## Goal

Transition the Certificates feature from an incomplete URL-based system to a robust file-upload system integrated into the Results & Times and Profile views, improving discoverability, UX, and technical implementation.

## Current State Analysis

### Existing Certificate Infrastructure
- **Database**: `public.user_certificates` table with columns: `id`, `group_id`, `marathon_id`, `runner_id`, `user_id`, `title`, `url`, `notes`, `created_at`, `updated_at`
- **Unique constraint**: `(runner_id, marathon_id)`
- **RLS policies**: Users manage their own certificates (`user_id = auth.uid()`)
- **Trigger**: `trg_issue_certificate` on `registrations` auto-issues certificates when result status becomes `completed` or timing data is set
- **RPC**: `issue_certificate_for_result()` inserts into `user_certificates`
- **Current UI**: URL-only input (`res-certificate-url` type="url") in results edit form
- **Profile display**: Certificates section under Race History tab, derives from results when DB is empty
- **No file upload support**: All uploads are via pasted URLs

### Affected Screens
1. **Results & Times screen** (`renderResults()` at line 2852) - No certificates tab
2. **Profile screen** (`renderProfile()` at line 3406) - Certificates under Race History tab only
3. **Database**: `user_certificates` table already exists

## Affected Boundaries

### 1. Profile Navigation Tabs
- **Location**: `setProfileTab(tab)` function (line 3283) and `VALID` tab list
- **Current valid tabs**: `["overview", "analytics", "records", "badges", "history", "settings"]`
- **Required change**: Add `"certificates"` to the valid tab array, positioned per spec: `Overview, Analytics, Records, Badges, Race History, Certificates, Settings`

### 2. Profile Tab Panels
- **Location**: `index.html` profile tab panel definitions and `renderProfile()` function
- **Current**: Certificates embedded within `profile-panel-history`
- **Required change**: Create standalone `profile-panel-certificates` panel, move certificates rendering out of history panel

### 3. Results & Times Screen
- **Location**: `renderResults()` function (line 2852)
- **Current**: Single-tab interface for results
- **Required change**: Add "Certificates" tab alongside existing "Results" tab

### 4. Certificate CRUD Operations
- **Upload**: Replace URL input with native file upload `<input type="file">`
- **View**: Display stored certificate URL/metadata
- **Replace**: Upload new file to replace existing certificate
- **Remove**: Delete certificate from `user_certificates` table
- **Prerequisite**: Can only upload if a result exists for that user+race combination

### 5. Data Flow
- Certificates uploaded in Results & Times view must immediately reflect in Profile view and vice versa
- All certificate metadata linked to: `User ID` → `Runner ID` → `Marathon ID` → `Result ID`

## Implementation Roadmap

### Phase 1: UI/UX Structure

#### A. Profile Navigation - Add Certificates Tab
1. Update `setProfileTab(tab)` valid array in `app.js:3283`:
   - Change `["overview", "analytics", "records", "badges", "history", "settings"]` to `["overview", "analytics", "records", "badges", "history", "certificates", "settings"]`
2. Update `index.html` profile tab panel structure:
   - Add `profile-panel-certificates` panel alongside existing panels
   - Position: after `profile-panel-badges`, before `profile-panel-history`
   - Add tab button: `<button class="profile-tab" data-profile-tab="certificates">Certificates</button>`
3. Update `renderProfile()` to handle the new tab (the existing `setProfileTab` mechanism will handle showing/hiding)

#### B. Results & Times - Add Certificates Tab
1. Refactor `renderResults()` to include a tabbed interface
2. Add "Certificates" tab that displays races with results where certificates can be managed
3. Maintain existing "Results" tab behavior unchanged

### Phase 2: Prerequisite Logic & File Upload

#### A. Result-Dependency Validation
1. Create helper function `hasResultForMarathon(runnerId, marathonId)` that checks if the user has a logged result (status=`completed` or with finish times) for the given race
2. Integrate validation into certificate upload flow:
   - Before enabling upload button: check `hasResultForMarathon()`
   - If no result: display instructional message "Log a result first before uploading a certificate."
   - Grey out/disable upload controls when prerequisite not met

#### B. File Upload Component
1. Replace `res-certificate-url` `<input type="url">` with file upload input
2. Support formats: JPG, PNG, PDF (per storage configuration)
3. Upload flow:
   - User selects file → create `FormData` → upload to Supabase Storage
   - Store file URL in `user_certificates` table linked to `runner_id`, `marathon_id`, `result_id`
4. Display uploaded file as certificate card with preview

### Phase 3: CRUD Functionality

#### A. Upload (Results & Times Certificates Tab)
1. When user selects file:
   - Validate result exists for that race
   - Upload to Supabase Storage (bucket: certificates or similar)
   - Insert record into `user_certificates` with: `runner_id`, `marathon_id`, `result_id`, `url`, `title`, `notes`
   - Refresh certificate display

#### B. Upload (Profile Certificates Tab)
1. Same upload flow but initiated from Profile
2. Use same storage and DB insert logic

#### C. View Certificate
1. Display certificate card with:
   - Marathon name, distance, date
   - Finish time, place
   - Certificate preview/thumbnail
   - "View full certificate" button (opens URL in new tab)

#### D. Replace Certificate
1. Allow user to upload new file to replace existing
2. Update `user_certificates.url` with new file URL
3. Preserve metadata (marathon_id, runner_id, result_id)

#### E. Remove Certificate
1. Delete from `user_certificates` table
2. Remove certificate card from UI
3. Show empty state when no certificates remain

### Phase 4: Synchronization & Regression

#### A. Cross-View Synchronization
1. Ensure `renderCertificates()` fetches from `user_certificates` table (not just derived from results)
2. When certificate is uploaded/replaced/deleted in either view, refresh the other view
3. Use realtime subscriptions or manual refresh after CRUD operations

#### B. Regression Testing
1. Verify existing Results & Times functionality unchanged (results tab still works)
2. Verify Profile existing tabs still work (overview, analytics, records, badges, history, settings)
3. Verify certificate cards from existing URLs still display correctly
4. Verify derived certificates (from results without DB entries) still work

#### C. Design System Compliance
1. Adhere to existing dark design language
2. Use consistent card layouts (`.certificate-card` pattern from `renderCertificates()`)
3. Use empty states when no certificates present (`.empty` component pattern)
4. Use consistent button styles (`.btn-primary`, `.btn-secondary`)
5. Maintain responsive grid (certificates-grid adapting from 4-col to 1-col)

## Technical Specifications

### Storage Configuration
- Supabase Storage bucket for certificate files
- File types: JPG, PNG, PDF
- Public URL storage pattern: `supabase.storage.from('certificates').getPublicUrl(path)`
- File path format: `certificates/{runner_id}/{marathon_id}_{result_id}_{filename}`

### RLS & Permissions
- **Ownership**: Users can only manage their own certificates (`user_id = auth.uid()`)
- **Existing admin permissions**: Preserve any existing admin override permissions
- **Insert policy**: Authenticated users where `user_id = auth.uid()`
- **Update policy**: Authenticated users where `user_id = auth.uid()`  
- **Delete policy**: Authenticated users where `user_id = auth.uid()`

### Data Model Enhancements
- `user_certificates` table may need `result_id` column added (currently may not exist)
- Migration: Add `result_id` column to `user_certificates` if not present
- Index on `result_id` for lookup performance

### Empty States
- Results & Times Certificates tab: "No results logged for this race. Log a result first before uploading a certificate."
- Profile Certificates tab: "No certificates yet. Finish a race to earn a certificate." or "Log a result first before uploading a certificate."
- Consistent with existing `.empty` dashed border pattern

## Rollback & Migration

### Potential Rollback Points
1. If `result_id` column migration fails, revert DB schema change
2. If file upload component causes issues, revert to URL input
3. If tab switching breaks profile, restore original tab array

### Migration Checklist
- [ ] Add `result_id` column to `user_certificates` table (if not exists)
- [ ] Create Supabase Storage bucket `certificates`
- [ ] Update Profile tab navigation HTML
- [ ] Update Results & Times tab navigation
- [ ] Test certificate upload from both views
- [ ] Test certificate view/replace/remove in both views
- [ ] Verify cross-view synchronization
- [ ] Verify no regression in existing functionality

## Validation Plan

### Manual Testing Scenarios
1. **Upload certificate from Results & Times**: Log result → Go to Certificates tab → Upload file → Verify appears in Profile → Verify card displays correctly
2. **Upload certificate from Profile**: Same flow but initiated from Profile tab
3. **Replace certificate**: Upload new file → Verify old one replaced → Verify appears in other view
4. **Remove certificate**: Delete → Verify removed from both views → Empty state displayed
5. **No-result prevention**: Try to upload certificate for race without logged result → Should show "Log a result first" message
6. **Existing URL certificates**: Verify previously pasted URLs still display correctly
7. **Tab switching**: Verify all Profile tabs (overview through settings) still work
8. **Results tab integrity**: Verify Results tab still functions identically after refactor

### Edge Cases
- User with no race results attempting to access certificates tab
- Certificate upload with invalid file type
- Simultaneous certificate operations
- Network interruption during upload
- Orphaned certificates (DB record without file)
- Multiple results for same marathon (ensure correct result_id linkage)

## Open Questions & Dependencies

1. **Storage bucket name**: Should certificates use existing bucket or new `certificates` bucket? (Recommended: new `certificates` bucket)
2. **Result ID tracking**: Does `user_certificates` currently have `result_id` column, or needs migration? (Likely needs migration)
3. **Admin override**: Should admins be able to manage any user's certificates? (Current RLS is user-scoped only)
4. **File size limits**: What are the Supabase storage limits for the certificates bucket?
5. **Preview generation**: Should thumbnails be generated for PDFs, or only display generic icon?
6. **Existing certificate URLs**: How to migrate existing pasted URLs to new file-based system? (Optional: keep URL field for backward compat)

## Success Metrics

- [ ] Certificates tab added to Profile navigation (visible, functional)
- [ ] Certificates tab added to Results & Times screen (functional, doesn't break results)
- [ ] File upload works for JPG, PNG, PDF formats
- [ ] Upload prevents when no result logged for that race
- [ ] Certificates appear in both Results & Times and Profile views
- [ ] CRUD (Create, View, Replace, Remove) all functional
- [ ] No regression in existing Results or Profile functionality
- [ ] Design follows existing dark theme and component patterns