---
version: alpha
name: PacePack
description: A dark, performance-oriented design system for a running club race tracker. Technical, precise, and athletic with an electric blue accent.
colors:
  primary: "#0042FF"
  primary-hover: "#1A5CFF"
  secondary: "#FFFFFF"
  tertiary: "#94A3B8"
  neutral: "#0B1220"
  surface: "#111827"
  surface-elevated: "#1E293B"
  on-surface: "#FFFFFF"
  muted: "#64748B"
  border: "#334155"
  success: "#22C55E"
  warning: "#F59E0B"
  error: "#EF4444"
typography:
  headline-display:
    fontFamily: "Inter"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline-lg:
    fontFamily: "Inter"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline-md:
    fontFamily: "Inter"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
  headline-sm:
    fontFamily: "Inter"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: "Inter"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: "Inter"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Inter"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label-lg:
    fontFamily: "Inter"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  label-md:
    fontFamily: "Inter"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: "Inter"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.02em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
rounded:
  none: 0px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    border: "1px solid {colors.border}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label-md}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.md}"
    padding: "16px"
  input:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.on-surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "40px"
  sidebar:
    backgroundColor: "{colors.neutral}"
    width: "240px"
    collapsedWidth: "64px"
  table:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border}"
    headerBackground: "{colors.surface-elevated}"
---

# PacePack Design System

## Overview
PacePack is a dark, performance-focused interface designed for running clubs that track races, results, and runners. The system prioritizes clarity, speed of scanning, and a precise athletic feel. It draws inspiration from motorsport and performance engineering — clean, high-contrast, and data-friendly — while remaining comfortable for daily use across dashboards, tables, and admin screens.

There is no public marketing page. The experience begins at Sign In and continues into a functional app panel with Dashboard, Marathons, Runners, Registrations, Results & Times, Community, and Admin sections.

## Colors
- **Primary (#0042FF):** Electric blue used for primary actions, active navigation states, key metrics, and countdown numbers. It signals speed and precision.
- **Primary Hover (#1A5CFF):** Slightly brighter blue for interactive feedback.
- **Secondary (#FFFFFF):** Primary text and high-emphasis content.
- **Tertiary (#94A3B8):** Secondary text and supporting labels.
- **Neutral (#0B1220):** Deep background for the overall app shell.
- **Surface (#111827):** Default card and panel background.
- **Surface Elevated (#1E293B):** Slightly lifted surfaces for inputs, table headers, and nested elements.
- **Muted (#64748B):** Low-emphasis text, placeholders, and icons.
- **Border (#334155):** Subtle structural lines for cards, tables, and dividers.
- **Success (#22C55E):** Positive states (Finished, Registered, new PR).
- **Warning (#F59E0B):** Caution states (Waitlist, pending).
- **Error (#EF4444):** Negative states (DNS, DNF, failed actions).

## Typography
Inter is the primary typeface for its excellent readability at small sizes and strong numeric clarity. Use JetBrains Mono (or system mono) for times, paces, and race numbers to reinforce the performance/data character.

- Large headings are reserved for page titles and major dashboard metrics.
- Body text stays compact for dense screens (Registrations, Results, Runners).
- Labels are slightly heavier to improve scanability in tables and forms.
- Mono font should be used for all finish times, paces, and countdown digits.

## Layout
The app uses a persistent left sidebar with a collapsible state. Content areas should feel structured but not cramped.

- Sidebar width: 240px (expanded) / 64px (collapsed)
- Consistent page padding and card spacing
- Clear separation between Member pages and Admin pages
- Tables should be full-width within the content area with sticky headers where useful
- Dashboard uses a responsive card grid (3 columns on desktop, 2 on tablet, 1 on mobile)

## Core Components

### Buttons
- **Primary:** Solid electric blue, white text, 40px height, small radius.
- **Secondary:** Transparent with border, used for secondary actions.
- **Ghost:** Minimal, used for low-emphasis actions and icon buttons.

### Cards (Base)
Dark surfaces with subtle borders. Used for dashboard widgets, race countdown, stats, and content blocks. Avoid heavy shadows.

| Property       | Value                        |
|----------------|------------------------------|
| Background     | `surface` (`#111827`)        |
| Border         | `1px solid border`           |
| Border Radius  | `8px`                        |
| Padding        | `16px`                       |
| Shadow         | None                         |

### Inputs & Forms
Slightly elevated dark fields with clear focus states using the primary blue. Consistent 40px height for alignment with buttons.

### Sidebar
Darker than the main content area. Active item uses the primary blue accent (left border + text color). Icons remain simple and monochrome.

### Tables
Clean, high-contrast tables for Registrations, Results & Times, and Runners. Header rows use elevated surface color. Support compact row height for data density.

### Status Badges
Small pills for registration status (Registered, Waitlist, DNS, DNF, Finished) and role badges in Admin.

---

## Dashboard Cards

Dashboard cards give users a fast overview of group activity. Each card should communicate one clear idea.

### Structure
- Optional small icon or label at the top
- Large primary metric
- Supporting label
- Optional trend indicator or mini visualization

### Recommended Variants

| Card Type           | Purpose                              | Visual Emphasis      |
|---------------------|--------------------------------------|----------------------|
| Stat Card           | Total runners, active this week      | Large number         |
| Countdown Card      | Next race countdown                  | Strong hierarchy     |
| Race Preview Card   | Next race name, date, location       | Image + text         |
| Activity Card       | Recent results or registrations      | Compact list         |
| Quick Action Card   | Add Result / Add Marathon            | Button focused       |

### Countdown Card
Special treatment for the next race:
- Large time blocks (Days / Hours / Mins / Secs)
- Each unit sits in its own small elevated surface
- Race name and location appear as supporting text
- Optional race image on the left side
- Use mono font for the digits

### Design Rules
- One primary idea per card
- Primary metric uses `headline-lg` or larger
- Secondary text uses muted color
- Electric blue reserved for key numbers or active states
- Consistent 16px padding and 8px radius

---

## Analytics Cards

Analytics cards focus on trends and insights rather than single static values.

### Common Analytics Cards
- Participation rate
- Average pace trend
- Distance mix
- Weekly / monthly volume
- PR rate
- Most active runners
- Busiest races

### Layout Options
1. **Metric + Sparkline** — main number with a small trend line
2. **Metric + Comparison** — current value vs previous period
3. **Chart Card** — bar, line, or simple donut
4. **Breakdown Card** — horizontal bars or stacked segments

### Design Rules
- Charts stay minimal (light or no gridlines)
- Primary blue for the main data series
- Muted gray for comparison data
- Prefer horizontal bar charts for ranked information
- Keep axis labels small and low-contrast

### Content Hierarchy


---

## Page-Specific Notes

- **Dashboard:** Emphasize countdown, key metrics, and recent activity. Use a clear card grid.
- **Marathons / Runners / Registrations / Results:** Prioritize scannable tables and filtering.
- **Community:** Allow slightly more breathing room for posts and conversation.
- **Admin – Team & Access / Notifications:** More compact controls and stronger form hierarchy.

## Do's and Don'ts

**Do**
- Keep the interface dark and high-contrast
- Use electric blue sparingly for emphasis and actions
- Favor compact, precise controls suitable for data work
- Make numbers and times the visual heroes
- Maintain clear distinction between member and admin areas

**Don’t**
- Introduce bright secondary colors or playful illustrations
- Use heavy shadows or glass effects
- Make buttons or inputs oversized
- Overcrowd cards with multiple competing metrics
- Sacrifice readability of times and paces for style


---

## Leaderboard Cards

Leaderboard cards highlight competition and recognition inside the group. They should feel motivating while remaining clean.

### Recommended Types
- Top Mileage (month / all-time)
- Most Consistent
- Fastest recent race
- Most Improved
- Recent Personal Bests

### Structure
- Rank number
- Runner avatar + name
- Key metric (time, pace, distance, or streak)
- Optional badge or change indicator

### Rank Treatment

| Rank | Visual Treatment                        |
|------|-----------------------------------------|
| 1st  | Slightly stronger background or accent  |
| 2nd  | Standard elevated surface               |
| 3rd  | Standard elevated surface               |
| 4+   | Flatter, more compact rows              |

### Design Rules
- Keep rows compact and scannable
- Avatar size consistent
- Metric aligned to the right
- Use mono font for times and paces
- Show top 5–8 entries with a “View all” link
- Avoid heavy decorative medals or icons

### Compact Row Example