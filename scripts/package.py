from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))
out = root / 'dist'
out.mkdir(exist_ok=True)
target = out / f"AIHubRouter-{manifest['version']}-chromium.zip"
allowed = {'.js', '.json', '.html', '.css', '.png'}
install = """# AIHubRouter 安装说明

适用于 Chrome / Microsoft Edge 120 及以上版本。

1. 解压本 ZIP 文件。
2. Chrome 打开 chrome://extensions，Edge 打开 edge://extensions。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择解压后直接包含 manifest.json 的目录。
5. 在同一浏览器登录 https://aihub.top，打开插件，在“监控”页点击“读取 key”。
6. 在 key 右侧的模型下拉框中选择模型即开始监控。初次默认仅预览；核对候选后，在监控卡片中开启“自动改组”。

升级时覆盖原安装目录，再在扩展管理页点击“重新加载”，以保留扩展身份和配置。

自动改组及确认手动切换会实际修改平台 key 的首选分组。真实平台改组尚未由维护者实测，自动化验证使用模拟数据。

项目与完整说明：https://github.com/tibbar213/AIHubRouter
反馈问题：https://github.com/tibbar213/AIHubRouter/issues
请勿在反馈中提供完整 API key、网站登录令牌或带凭据的 HAR。
"""
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
    for p in sorted((root / 'extension').rglob('*')):
        if p.is_file():
            assert p.suffix in allowed, f'Unexpected package file: {p.name}'
            z.write(p, p.relative_to(root / 'extension'))
    z.write(root / 'LICENSE', 'LICENSE')
    z.write(root / 'PRIVACY.md', 'PRIVACY.md')
    z.writestr('INSTALL.md', install)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
checksum = target.with_suffix(target.suffix + '.sha256')
checksum.write_text(f'{digest}  {target.name}\n', encoding='ascii')
print(target)
print('SHA256', digest)
print(checksum)
