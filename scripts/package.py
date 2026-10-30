from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
root=Path(__file__).resolve().parents[1]
out=root/'dist';out.mkdir(exist_ok=True)
target=out/'AIHubRouter-0.3.5-chromium.zip'
allowed={'.js','.json','.html','.css','.png'}
with ZipFile(target,'w',ZIP_DEFLATED) as z:
    for p in sorted((root/'extension').rglob('*')):
        if p.is_file():
            assert p.suffix in allowed, f'Unexpected package file: {p.name}'
            z.write(p,p.relative_to(root/'extension'))
    z.write(root/'README.md','README.md')
    for p in sorted((root/'docs').glob('*.md')):
        z.write(p,'docs/'+p.name)
print(target)
print('SHA256',hashlib.sha256(target.read_bytes()).hexdigest())
