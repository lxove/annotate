# annotate

Peka, rita och kommentera på valfri lokal sida (`localhost`, `*.localhost`, `*.test` eller hostnamn du lägger till). En Claude Code-session i rätt repo plockar upp kommentarerna, genomför dem och svarar i bubblan. Inga ändringar behövs i repona.

```
Chrome-tillägg (overlay)  ⇄  annotate-server 127.0.0.1:4747  ⇄  ~/.annotate/annotations.db  ⇄  annotate wait (Claude-session)
```

## Installation
Kräver Node 22.13+, Chrome och Claude Code.

```sh
git clone <repo-url> annotate && cd annotate
./install.sh
```

`install.sh` installerar CLI:t `annotate` (via `npm link`) och länkar Claude-skillen till `~/.claude/skills/annotate`,
så att den gäller i alla repon. Sedan återstår ett manuellt steg, en gång:
Chrome → `chrome://extensions` → slå på **Developer mode** → **Load unpacked** → välj mappen `extension/` i repot.

**Uppdatera:** `git pull && ./install.sh`, och tryck sedan på ↻ för tillägget i `chrome://extensions`.

## Innehåll
```
bin/annotate.mjs          CLI (wait, done, list, allow-host, server …)
lib/                      server + SQLite (~/.annotate/)
extension/                Chrome-tillägget (överlägg, React-probe, key-guard)
skills/annotate/SKILL.md  Claude Code-skillen som driver loopen
install.sh                installation och uppdatering
```

## Användning
I valfritt repo, med appen igång: säg **"starta annoteringsläget"** till Claude.
Claude tar reda på vilken port appen körs på och lyssnar på den.

I webbläsaren:
- **✎** eller **Alt+A**: slå på eller av annoteringsläget
- **Klick**: kommentera ett element. **Dra**: rita en yta
- **Skicka (n)**: skickar utkasten. Statusraden visar vilken session som lyssnar (`→ customer-portal`)
- Nålarnas färger: blå = utkast, orange = i kö, lila = pågår, grön = klar (klicka för att läsa svaret)

På React-sidor skickas komponentnamnen med (`StationTable < StationsPage`), så att Claude hittar rätt fil direkt.

## CLI
```
annotate wait --origin http://localhost:3000   # används av Claude
annotate done <id> "svar"
annotate list [--origin o] [--status s]
annotate allow-host <host>
annotate status | start | stop
annotate clear-done [--origin o]
```

## Andra lokala hostnamn
`localhost`, `127.0.0.1`, `*.localhost` och `*.test` (t.ex. `https://fishstew.test`) fungerar direkt.
För andra namn, t.ex. `myapp.local`: kör `annotate allow-host myapp.local` och ladda om tillägget.

## Tangentbord och fokus
När en bubbla är öppen ser sidan inga tangenttryck, klick eller fokusändringar från den. Sidans kortkommandon
reagerar alltså inte när du skriver, och öppna dialoger stängs inte. När bubblan är stängd fungerar sidan som vanligt.

## Säkerhet
Servern binder bara till 127.0.0.1 och tar bara emot anrop från lokala origins (se ovan). `.localhost` och `.test`
är reserverade toppdomäner som bara kan peka hit via din egen konfiguration. En vanlig webbplats kan alltså inte
lägga in "instruktioner" som din Claude-session sedan utför.

## Utan Chrome-tillägget
Lägg till `<script src="http://127.0.0.1:4747/overlay.js"></script>` i dev-läge. Det fungerar inte på sidor
med strikt CSP (t.ex. customer-portal), och komponentnamn kräver tillägget.

## Efter ändringar i `extension/`
Tryck på ↻ för tillägget i `chrome://extensions` och ladda om sidan.
