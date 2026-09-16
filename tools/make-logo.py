"""로고와 앱 아이콘을 만든다.

tools/logo-source.png 는 나무 탁자 위에 놓인 픽셀아트 사진이다. 여기서 검은
둥근 사각형만 오려내고 바깥(나무·천)은 투명하게 지운다.

    pip install Pillow
    python3 tools/make-logo.py
"""
from collections import deque
from PIL import Image, ImageFilter

SRC = 'tools/logo-source.png'

# 나무와 천은 따뜻한 색(R 이 B 보다 뚜렷이 높다). 로고 안쪽은 어두운 청록,
# 민트, 회색 털뿐이라 모두 R <= B 쪽이다. 이 차이로 배경을 가른다.
WARM = 12


def background_mask(im):
    w, h = im.size
    px = im.load()
    warm = [[(px[x, y][0] - px[x, y][2]) > WARM for y in range(h)] for x in range(w)]

    # 네 모서리에서 번져 나가며 바깥 배경만 고른다.
    # 로고 안에 우연히 따뜻한 점이 있어도 안쪽은 건드리지 않는다.
    seen = [[False] * h for _ in range(w)]
    q = deque()
    for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if warm[sx][sy]:
            seen[sx][sy] = True
            q.append((sx, sy))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[nx][ny] and warm[nx][ny]:
                seen[nx][ny] = True
                q.append((nx, ny))
    return seen


def extract():
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    outside = background_mask(im)

    alpha = Image.new('L', (w, h), 255)
    ap = alpha.load()
    for x in range(w):
        col = outside[x]
        for y in range(h):
            if col[y]:
                ap[x, y] = 0

    # 사진이라 경계에 나무색이 섞인 픽셀이 한 겹 남는다. 남길 영역을 2px 깎아 없앤다.
    alpha = alpha.filter(ImageFilter.MinFilter(5))

    out = im.convert('RGBA')
    out.putalpha(alpha)
    box = alpha.getbbox()
    return out.crop(box)


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).save(path)
    print(f'{path}  {size}x{size}')


logo = extract()
print('오려낸 크기:', logo.size)

save(logo, 'assets/logo.png', 256)
save(logo, 'icons/icon-192.png', 192)
save(logo, 'icons/icon-512.png', 512)

# 마스크 적용 아이콘: 안드로이드가 원형 등으로 잘라내므로 가장자리까지 색을 채우고
# 그림은 가운데 80% 안에 둔다.
edge = logo.convert('RGB').getpixel((logo.size[0] // 2, 2))
mask = Image.new('RGBA', (512, 512), edge + (255,))
inner = logo.resize((410, 410), Image.LANCZOS)
mask.paste(inner, (51, 51), inner)
mask.save('icons/icon-maskable-512.png')
print('icons/icon-maskable-512.png  512x512')
