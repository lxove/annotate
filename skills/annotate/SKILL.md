---
name: annotate
description: Annoteringsläge. Användaren klickar och ritar på sin lokala dev-sida i webbläsaren (localhost, *.test m.fl.) och skriver vad som ska ändras, och du genomför ändringarna i en loop utan att hen behöver skriva i terminalen. Använd när användaren säger "starta annoteringsläget", "annotate", "jag vill peka i webbläsaren" eller liknande, i vilket repo som helst.
allowed-tools: Bash(annotate *)
---

# Annoteringsläge

Verktyget är CLI:t `annotate` plus ett Chrome-tillägg. Båda installeras från annotate-repot med `./install.sh`, och `annotate help` visar repots sökväg.
Överlägget syns på lokala sidor (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`) så länge annotate-servern kör. `annotate wait` startar servern automatiskt.

## Starta
1. **Ta reda på vilken origin appen körs på** i det här repot, t.ex. `http://localhost:3000` eller `https://fishstew.test`.
   Titta i repots CLAUDE.md, package.json (`dev`-script), docker-compose-portar eller nginx-config.
   Om det finns flera kandidater eller du är osäker: fråga användaren en gång.
   Om hostnamnet inte är localhost, `*.localhost` eller `*.test`: kör `annotate allow-host <host>` och be användaren ladda om tillägget.
   Kontrollera med `curl -skI <origin>` att den svarar. Om dev-servern inte kör, starta den som repot brukar göra
   (i bakgrunden) eller be användaren starta den.
2. Kör `annotate wait --origin <origin>` med **run_in_background**. Flera origins går bra (`--origin` flera gånger).
   Säg kort till användaren: "Lyssnar på <origin>. Tryck ✎ (eller Alt+A) nere till höger, klicka eller rita, och tryck Skicka."
   Polla inte. Du blir väckt när kommandot avslutas.

## Loopen
3. När `annotate wait` avslutas innehåller utskriften annoteringarna: kommentar, sida, selector, position, html-utdrag
   och, för React-appar, **komponenter** (innerst först). Börja i den innersta komponenten när du letar efter rätt fil
   (`grep -rn "function StationTable\|StationTable ="`), och använd html-utdraget och texten för att bekräfta.
   För en **yta** är selectorn och komponenterna det minsta element som omsluter rektangeln. Det betyder oftast "lägg något nytt här".
4. Genomför ändringarna. Följ repots egna konventioner i CLAUDE.md (stil, i18n, komponentbibliotek, tester).
5. Markera varje annotering som klar med ett kort svar. Svaret visas i bubblan i webbläsaren:
   `annotate done <id> "Lade till kolumnen Status i StationTable"`
   Om något är oklart: gör din bästa tolkning och skriv det i svaret, eller skriv en motfråga i svaret och markera den ändå som klar.
   Användaren kan öppna den igen.
6. Gå tillbaka till steg 2 med samma origin(s). Fortsätt tills användaren säger stopp.

## Regler
- Markera annoteringarna som klara **innan** du kör `annotate wait` igen. Annoteringar som står kvar på `working` för det här repot plockas upp direkt igen.
- Håll chattsvaren korta. Användaren tittar på webbläsaren.
- Committa inte om användaren inte ber om det.
- Om ändringen kräver en omstart som inte sker automatiskt (t.ex. en Python-backend utan reload, eller en docker-container), gör omstarten eller skriv i svaret att den behövs.

## Övrigt
- `annotate list --origin <o>`: se alla annoteringar. `annotate status`: server och vem som lyssnar på vad.
- Om `annotate` saknas: be användaren köra `./install.sh` i annotate-repot.
- Om användaren inte ser ✎: tillägget är inte installerat eller inte omladdat (se README i repot), eller servern kör inte (`annotate start`).
