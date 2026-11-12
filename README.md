# Baywatch Bootcamp

Die sichtbare Versionsnummer steht in der Fußzeile von `index.html`. Erhöhe bei jedem kleinen App-Update die letzte Stelle, etwa von `0.1.0` auf `0.1.1`.

Eine private Fitness-Challenge für einen Freundeskreis. Alle Teilnehmer sehen dieselben Ziele. Einträge und Rangliste werden geräteübergreifend in SQLite gespeichert.

## Lokal starten

Node.js 24 oder neuer genügt. Aus dem Projektordner in PowerShell starten:

```powershell
$env:REPDECK_INVITE = 'repdeck-lokaler-testcode'
node server.mjs
```

[Baywatch Bootcamp lokal öffnen](http://127.0.0.1:3000). Unter **Anmelden → Konto erstellen** einen Namen, ein Passwort mit mindestens zehn Zeichen und den Einladungscode eingeben. Für eine zweite Person einen anderen Browser oder ein privates Fenster nutzen.

## Online für Freunde

Die Migrationen unter `supabase/migrations` gehen von einem leeren Projekt aus. Die Edge Function verwendet einen serverseitigen Einladungscode `BOOTCAMP_INVITE` und erlaubt Aufrufe von `BOOTCAMP_ORIGIN`. Öffentliche Auth-Registrierungen müssen im Supabase-Projekt deaktiviert sein, damit neue Konten über die Einladungsprüfung laufen.

Der GitHub-Pages-Workflow baut die Oberfläche mit den Repository-Variablen `BOOTCAMP_SUPABASE_URL` und `BOOTCAMP_PUBLISHABLE_KEY`. Vor der Veröffentlichung prüft er, ob die Supabase-Funktion eine gültige Gastansicht ausliefert. Eine lokal gestartete App verwendet weiterhin die Node-API. Das Pages-Artefakt enthält HTML, CSS, JavaScript und ausschließlich öffentliche API-Konfiguration.

Der mitgelieferte Dockerfile startet die App als einzelner Node-Dienst. Der Hoster muss HTTPS und ein persistentes Volume unterstützen.

- Container-Port **3000** über die HTTPS-Domain des Hosters erreichbar machen.
- Ein persistentes Volume unter **/data** bereitstellen und dem Container-Benutzer **node** Schreibrechte geben. Die SQLite-Datenbank in regelmäßige Backups aufnehmen.
- **REPDECK_INVITE** als geheime Umgebungsvariable mit mindestens 16 zufälligen Zeichen setzen.
- Eine Instanz betreiben. Die HTTPS-Adresse und den Code direkt mit dem Freundeskreis teilen.

Die Login-Seite ist über die URL aufrufbar. Registrierung, Einträge und gemeinsame Ranglisten sind durch Einladung und Sitzung geschützt. Ein geänderter Einladungscode gilt für neue Registrierungen.

## Meldungen und Admin-Zugang

Unter **Bugs & Ideen** können angemeldete Mitglieder Fehler, Feedback und Ideen einreichen und den Status ihrer eigenen Meldungen sehen. Admins sehen alle Meldungen im Postfach und können sie quittieren, abschließen oder wieder öffnen.

Registriere zuerst dein Konto in der App. Erteile anschließend diesem Konto auf dem Rechner oder im Container, der Zugriff auf dieselbe SQLite-Datenbank hat, Adminrechte. Ersetze `DeinName` durch deinen Kontonamen.

```powershell
node server.mjs --grant-admin DeinName
```

In Docker lautet der Befehl `docker exec <containername> node server.mjs --grant-admin DeinName`. Lade danach die App neu. Unter **Bugs & Ideen** erscheint das **Admin-Postfach**. Der normale Einladungscode erstellt ausschließlich Mitgliedskonten.

## Wertung

Die Hauptwertung läuft in festen Zweimonatsrunden, beginnend mit Januar und Februar. Die nächste Runde beginnt am ersten Tag des nächsten Zweimonatsblocks um 00:00 Uhr in Berlin. Die vorige Runde zeigt Platz 1 für den Döner der Gruppe. Bei Gleichstand werden alle Erstplatzierten angezeigt. All-Time zählt über die Runden hinweg.

Unter **Challenges verwalten → Notfall-Reset der Punkte** kann ein Admin mit dem eigenen Passwort und der Eingabe `PUNKTE RESETTEN` alle laufenden Punktekonten einschließlich All-Time zurücksetzen. Konten, Münzen und Aufgabenfortschritt bleiben erhalten. Der Reset wird mit Datum und Admin gespeichert.

- Jeden Tag dieselben fünf klassischen Übungen mit Zielwerten von 10 Liegestützen, 30 Plank-Sekunden, 3 Klimmzügen, 15 Bauchaufzügen und 15 Kniebeugen. Tagesmengen lassen sich erhöhen und korrigieren.
- In der Online-App bringt jedes Tagesziel 60 Punkte. Teilfortschritt zählt proportional. Die Bonuswertung läuft mit einem Viertel des normalen Satzes bis zum doppelten Soll und bringt maximal 15 Zusatzpunkte je Übung. Bruchteile werden abgerundet. Nach Tagesende werden ab Einführung der Regel 10 Punkte pro fehlendem Ziel abgezogen. Ein freier Tag zählt als erfüllt.
- Jeden Montag um 00:00 Uhr wechselt die App auf drei zufällig gezogene Wochenaufgaben, eine aus jeder Kategorie. Um 00:00 Uhr beginnt jeweils die neue Tageschallenge. Die App speichert Aufgaben, Fortschritt und Punkte pro Zeitraum. Die Auswahl wird beim ersten Aufruf im jeweiligen Zeitraum gespeichert.
- Unter **Challenges verwalten** können Admins Ziele, Wertung und Anleitung ändern, neue Übungen oder Wochenaufgaben anlegen und Einträge deaktivieren. Tagesänderungen gelten ab dem nächsten Tag, Änderungen am Wochenpool ab der nächsten Montagsauslosung.
- Das freiwillige Glücks- & Pechrad öffnet sich nach allen fünf Tageszielen. Die Extrarunde bringt 5 Punkte und beim ersten Dreh einen Bonusdreh. Pro Tag sind maximal zwei Drehs möglich. Direkte Gewinne und Abzüge zählen sofort. Aufgaben gelten bis Mitternacht. Bei der Liegestütz-Rettung holst du dir die 30 abgezogenen Punkte zurück, wenn du die Aufgabe erledigst. Beide Drehs zählen zu den Tagespunkten und beiden Ranglisten.
- Jeder Dreh hat zusätzlich eine Chance von eins zu drei auf 1–3 Münzen. Das Feld **Freier Tag** gibt einen Gutschein fürs Münzkonto. Du kannst ihn für den aktuellen Tag einlösen oder aufheben.
- Im Münzkonto kosten Sprachnachrichten 2 Münzen, Symbol-Pranks 5, Extraübungen 6, Retourkutschen 4 und ein freier Tag 12. Ein freier Tag ergänzt fehlende Zielpunkte, zählt fürs Monatsziel und öffnet das Rad. Die Mikrofonaufnahme läuft auf HTTPS oder localhost mit Mikrofonfreigabe.
- Zwölf vollständige Trainingstage im Kalendermonat bringen 100 Punkte für die Monatsrangliste. Wochenaufgaben zählen dort zum Monat ihres Startmontags.
- Alle Wechsel folgen **Europe/Berlin**. Einträge basieren auf Selbstauskunft. Die Gruppe kann zu Beginn gemeinsame Regeln für Übungsvarianten vereinbaren.
