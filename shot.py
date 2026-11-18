from playwright.sync_api import sync_playwright
B="https://san-jose.bascula.engp.io"
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",headless=True)
    pg=b.new_page(viewport={"width":1440,"height":900},locale="es-CO")
    pg.goto(B+"/",wait_until="networkidle")
    pg.get_by_text("Entrar").first.click()
    pg.wait_for_timeout(1500)
    print(pg.url, [(i.get_attribute("type"),i.get_attribute("name")) for i in pg.query_selector_all("input")])
    pg.fill("input[type=email], input[name=email], input[type=text]","oscar3425@gmail.com")
    pg.fill("input[type=password]","buenosaires5")
    pg.keyboard.press("Enter")
    pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(3000)
    print(pg.url)
    pg.screenshot(path="shots/01-dashboard.png",full_page=True)
    links=pg.eval_on_selector_all("a","els=>els.map(e=>[e.innerText.trim(),e.getAttribute('href')])")
    print(links)
    pg.context.storage_state(path="state.json")
    b.close()
