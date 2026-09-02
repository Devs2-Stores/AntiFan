import sys
import os
import json
from PIL import Image, ImageChops, ImageDraw

def compare_images(baseline_path, clone_path, diff_output_path=None, threshold=15):
    """
    Compares two images and returns mismatch statistics:
    - total_pixels
    - diff_pixels
    - mismatch_percentage
    - diff_bounding_boxes
    """
    if not os.path.exists(baseline_path):
        raise FileNotFoundError(f"Baseline image not found: {baseline_path}")
    if not os.path.exists(clone_path):
        raise FileNotFoundError(f"Clone image not found: {clone_path}")

    img1 = Image.open(baseline_path).convert('RGB')
    img2 = Image.open(clone_path).convert('RGB')

    # Normalize to common dimensions if slight difference, or use the baseline size
    w = min(img1.width, img2.width)
    h = min(img1.height, img2.height)

    img1 = img1.crop((0, 0, w, h))
    img2 = img2.crop((0, 0, w, h))

    total_pixels = w * h
    diff = ImageChops.difference(img1, img2)
    diff_data = diff.getdata()

    diff_pixels = 0
    diff_mask = Image.new('L', (w, h), 0)
    diff_mask_pixels = diff_mask.load()

    for y in range(h):
        for x in range(w):
            r, g, b = diff_data[y * w + x]
            # Euclidean color distance
            dist = (r*r + g*g + b*b) ** 0.5
            if dist > threshold:
                diff_pixels += 1
                diff_mask_pixels[x, y] = 255

    mismatch_percentage = (diff_pixels / total_pixels) * 100.0 if total_pixels > 0 else 0.0

    if diff_output_path:
        # Create visual diff overlay
        overlay = img1.copy()
        highlight = Image.new('RGB', (w, h), (255, 0, 0))
        # Blend diff regions with red highlight
        overlay.paste(highlight, (0, 0), diff_mask)
        combined = Image.blend(img1, overlay, 0.6)
        combined.save(diff_output_path)

    result = {
        "width": w,
        "height": h,
        "total_pixels": total_pixels,
        "diff_pixels": diff_pixels,
        "mismatch_percentage": round(mismatch_percentage, 2),
        "match": mismatch_percentage < 10.0
    }
    return result

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python visual_diff.py <baseline_png> <clone_png> [diff_output_png]")
        sys.exit(1)
    baseline = sys.argv[1]
    clone = sys.argv[2]
    diff_out = sys.argv[3] if len(sys.argv) > 3 else None
    res = compare_images(baseline, clone, diff_out)
    print(json.dumps(res, indent=2))
