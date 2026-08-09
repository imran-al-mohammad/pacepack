"""
Generate PWA app icons from the PacePack brand mark.
Uses PIL to draw the circular gradient badge + white running-figure icon.
"""
from PIL import Image, ImageDraw
import os

# Brand colors (from styles.css)
COLOR_START = (217, 208, 209)  # #D9D0D1 (--accent)
COLOR_END = (169, 151, 150)    # #a99795
WHITE = (255, 255, 255, 255)

BASE = 512  # base icon size
S = BASE / 32  # scale factor (32x32 viewBox -> 512x512)

def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))

def bezier_points(p0, p1, p2, p3, steps=100):
    """Compute points along a cubic Bezier curve."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        mt = 1 - t
        x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
        y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts

def create_gradient_bg(size, c1, c2, corner_radius):
    """Create a rounded-rect background with a 135deg diagonal gradient."""
    # Build gradient data efficiently using putdata
    data = []
    for y in range(size):
        for x in range(size):
            ratio = (x + y) / (2 * (size - 1))
            data.append(lerp_color(c1, c2, ratio))
    
    img = Image.new('RGB', (size, size))
    img.putdata(data)
    
    # Apply rounded corners via alpha mask
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, size, size), radius=corner_radius, fill=255)
    
    img.putalpha(mask)
    return img

def create_base_icon():
    """Create the 512x512 base icon."""
    # Corner radius (90px for 512px, matching SVG rx=90)
    cr = 90

    # --- Draw gradient background ---
    bg = create_gradient_bg(BASE, COLOR_START, COLOR_END, cr)
    
    # Create final RGBA image
    img = Image.new('RGBA', (BASE, BASE), (0, 0, 0, 0))
    img.paste(bg, (0, 0), bg)
    
    draw = ImageDraw.Draw(img)

    # --- Draw white icon elements ---
    sw = max(2, int(2 * S))  # stroke width, scaled from 2 in 32x32 viewBox

    # Circle: cx=16, cy=16, r=14
    cx, cy, r = 16 * S, 16 * S, 14 * S
    draw.ellipse(
        (cx - r, cy - r, cx + r, cy + r),
        outline=WHITE,
        width=sw
    )

    # Running figure curve: M8 18c2-4 4-6 8-6s6 2 8 6
    # First Bezier: P0=(8,18), P1=(10,14), P2=(12,12), P3=(16,12)
    pts1 = bezier_points((8, 18), (10, 14), (12, 12), (16, 12))
    # Second Bezier (smooth): P0=(16,12), P1=(20,12), P2=(22,14), P3=(24,18)
    pts2 = bezier_points((16, 12), (20, 12), (22, 14), (24, 18))
    all_pts = [(x * S, y * S) for x, y in pts1 + pts2[1:]]
    draw.line(all_pts, fill=WHITE, width=sw, joint='curve')

    # Tick marks: M12 12l2 8 2-5 2 5 2-8
    tick_pts = [(12, 12), (14, 20), (16, 15), (18, 20), (20, 12)]
    tick_pts = [(x * S, y * S) for x, y in tick_pts]
    draw.line(tick_pts, fill=WHITE, width=sw, joint='curve')

    return img

# Create base icon
print("Creating base 512x512 icon...")
base_img = create_base_icon()

# Generate all sizes
sizes = [48, 72, 96, 144, 152, 167, 180, 192, 384, 512]
for size in sizes:
    if size == BASE:
        img = base_img
    else:
        img = base_img.resize((size, size), Image.LANCZOS)
    output = os.path.join('icons', f'icon-{size}.png')
    img.save(output)
    print(f'  Generated {output} ({size}x{size})')

print('All icons generated successfully!')
