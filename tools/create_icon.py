from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

out = Path(__file__).resolve().parents[1] / "assets"
out.mkdir(parents=True, exist_ok=True)
size = 512
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
px = image.load()
for y in range(size):
    for x in range(size):
        dx, dy = x - 256, y - 256
        if dx * dx + dy * dy <= 245 * 245:
            t = (x + y) / (size * 2)
            px[x, y] = (int(155 - 74 * t), int(140 - 68 * t), int(255 - 35 * t), 255)
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((28, 28, 484, 484), radius=118, outline=(255, 255, 255, 28), width=4)
draw.ellipse((360, 110, 404, 154), fill=(189, 249, 225, 255))
draw.rounded_rectangle((115, 142, 397, 338), radius=36, fill=(21, 27, 69, 242))
draw.line((170, 183, 294, 183), fill=(237, 235, 255, 255), width=18)
draw.line((170, 224, 342, 224), fill=(237, 235, 255, 255), width=18)
draw.line((170, 265, 260, 265), fill=(237, 235, 255, 255), width=18)
draw.polygon((318, 271, 352, 237, 386, 271, 352, 305), fill=(124, 240, 192, 255))
draw.line((156, 376, 356, 376), fill=(255, 255, 255, 190), width=16)
font = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 42)
label = "豆包"
bbox = draw.textbbox((0, 0), label, font=font)
draw.text(((size - (bbox[2] - bbox[0])) / 2, 398), label, font=font, fill=(255, 255, 255, 255))
image.save(out / "doubao-manager.png")
image.save(out / "doubao-manager.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256),(512,512)])
