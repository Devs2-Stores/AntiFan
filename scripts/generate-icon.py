import os
import math
from PIL import Image, ImageDraw, ImageFilter

def create_antigravity_icon():
    os.makedirs('assets', exist_ok=True)
    size = 512
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Outer rounded container background with sleek dark gradient
    padding = 32
    radius = 110
    
    # Base squircle
    draw.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=radius,
        fill=(10, 15, 29, 255),
        outline=(56, 189, 248, 200),
        width=6
    )

    # 2. Glowing Inner Radial Glow
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    center = size // 2

    # Draw neon cyan and purple planetary orbital rings
    glow_draw.ellipse(
        [center - 180, center - 70, center + 180, center + 70],
        outline=(14, 165, 233, 230),
        width=14
    )
    glow_draw.ellipse(
        [center - 70, center - 180, center + 70, center + 180],
        outline=(168, 85, 247, 230),
        width=14
    )
    glow_draw.ellipse(
        [center - 140, center - 140, center + 140, center + 140],
        outline=(59, 130, 246, 200),
        width=10
    )

    # Core glowing orb
    for r in range(80, 0, -4):
        alpha = int(255 * (1 - r / 80) ** 0.8)
        color = (
            int(14 + (224 - 14) * (1 - r / 80)),
            int(165 + (242 - 165) * (1 - r / 80)),
            int(233 + (254 - 233) * (1 - r / 80)),
            alpha
        )
        glow_draw.ellipse([center - r, center - r, center + r, center + r], fill=color)

    # Combine
    img = Image.alpha_composite(img, glow)

    # Draw stylized central "A" symbol (Antigravity)
    final_draw = ImageDraw.Draw(img)
    
    # White sleek apex dot
    final_draw.ellipse([center - 16, center - 120, center + 16, center - 88], fill=(255, 255, 255, 255))
    
    # Left & right quantum satellites
    final_draw.ellipse([center - 130, center - 12, center - 106, center + 12], fill=(56, 189, 248, 255))
    final_draw.ellipse([center + 106, center - 12, center + 130, center + 12], fill=(192, 132, 252, 255))

    # Resize to 256 for standard high-res PNG
    png_256 = img.resize((256, 256), Image.Resampling.LANCZOS)
    png_256.save('assets/icon.png', 'PNG')
    print('Created assets/icon.png')

    # Save multi-resolution Windows ICO file
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    ico_imgs = [img.resize(s, Image.Resampling.LANCZOS) for s in sizes]
    ico_imgs[0].save('assets/icon.ico', format='ICO', sizes=[(s[0], s[1]) for s in sizes])
    print('Created assets/icon.ico with multi-resolution!')

if __name__ == '__main__':
    create_antigravity_icon()
