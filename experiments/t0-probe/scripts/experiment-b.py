"""实验 B：Camoufox 默认配置（对照 ADR 0004 实验 B）"""
import json, pathlib, datetime
from camoufox.sync_api import Camoufox

COLLECT = pathlib.Path(__file__).with_name("collect.js").read_text()
OUT = pathlib.Path(__file__).parent.parent / "results"

def run(tag: str) -> dict:
    with Camoufox(headless=False, humanize=True) as browser:
        page = browser.new_page()
        page.add_init_script(COLLECT)
        page.goto("https://example.com", wait_until="domcontentloaded")
        fp = page.evaluate("window.__collectFingerprint()")
        try:
            page.goto("https://abrahamjuliot.github.io/creepjs/", wait_until="networkidle", timeout=90000)
            page.wait_for_timeout(15000)
            trust = page.evaluate(
                """() => {
                    const el = [...document.querySelectorAll('*')].find(e => /trust score/i.test(e.textContent || '') && e.children.length < 5);
                    return el ? el.textContent.trim().slice(0, 120) : document.title;
                }"""
            )
        except Exception as e:
            trust = f"err:{e}"
    out = {"tag": tag, "fingerprint": fp, "creepTrust": trust, "at": datetime.datetime.now().isoformat()}
    (OUT / f"b-{tag}.json").write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[B/{tag}] ua={fp.get('userAgent','')[:60]} canvas={fp.get('canvasHash')} webgl={fp.get('webgl',{}).get('renderer','?')}")
    print(f"[B/{tag}] creep: {trust}")
    return out

b1 = run("run1")
b2 = run("run2")
same = json.dumps(b1["fingerprint"], sort_keys=True) == json.dumps(b2["fingerprint"], sort_keys=True)
print(f"[B] 两次启动指纹完全一致: {same}")
