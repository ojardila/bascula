from playwright.sync_api import sync_playwright
B="https://san-jose.bascula.engp.io"
pages=[("01-tablero","/tablero"),("03-cosecha-detalles","/cosecha/detalles"),("04-empleado","/empleados/32574201-2c19-541e-ba61-add88fdda052"),("05-nomina","/nomina"),("06-ventas","/ventas"),("07-lotes","/lotes")]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",headless=True)
    ctx=b.new_context(storage_state="state.json",viewport={"width":1440,"height":900},locale="es-CO")
    pg=ctx.new_page()
    errs=[]
    pg.on("console",lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("response",lambda r: errs.append(f"{r.status} {r.url}") if r.status>=400 else None)
    for n,u in pages:
        pg.goto(B+u,wait_until="networkidle"); pg.wait_for_timeout(2500)
        pg.screenshot(path=f"shots/{n}.png",full_page=True)
        print(n,pg.url,pg.inner_text("body")[:300].replace("\n"," | "))
    print("ERRS",errs)
    b.close()
