# Baywatch Bootcamp

Die sichtbare Versionsnummer steht in der Fußzeile von `index.html`. Erhöhe bei jedem kleinen App-Update die letzte Stelle, etwa von `0.1.0` auf `0.1.1`.

Eine private Fitness-Challenge für einen Freundeskreis. Die veröffentlichte App verwendet Supabase. Lokal läuft sie mit Node und SQLite.

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

## Meldungen und lokaler Admin-Zugang

Unter **Bugs & Ideen** können angemeldete Mitglieder Fehler, Feedback und Ideen einreichen und den Status ihrer eigenen Meldungen sehen. Admins sehen alle Meldungen im Postfach und können sie quittieren, abschließen oder wieder öffnen.

Registriere zuerst dein Konto in der App. Erteile anschließend diesem Konto auf dem Rechner oder im Container, der Zugriff auf dieselbe SQLite-Datenbank hat, Adminrechte. Ersetze `DeinName` durch deinen Kontonamen.

```powershell
node server.mjs --grant-admin DeinName
```

In Docker lautet der Befehl `docker exec <containername> node server.mjs --grant-admin DeinName`. Lade danach die App neu. Unter **Bugs & Ideen** erscheint das **Admin-Postfach**. Der normale Einladungscode erstellt ausschließlich Mitgliedskonten.

## Regeln und Wartung

Die aktuellen Spielregeln für die veröffentlichte App stehen im Info-Bereich. Für den Wochenpool und die Wochenpunkte ist Supabase maßgeblich. Die Funktion `bootcamp_private.weekly_points` definiert die Staffel. Katalog und Admin-Editor verwenden sie, und die Oberfläche liest die Werte aus dem aktuellen Spielstand. Bereits ausgeloste Wochen und verbuchte Punkte sind als eigene Daten gespeichert.

- `app.js` verbindet die App-Ansichten mit der API. `media-admin.mjs` verwaltet die ZIP-Sicherungen und das anschließende Löschen. `season-media.mjs` erstellt ZIP-Dateien und verkleinert Workout-Fotos.
- Neue Änderungen für Supabase gehören in eine neue Migration. Der lokale SQLite-Modus hat einen eigenen Aufgabenkatalog in `challenges.mjs` und deckt einen Teil der Online-Funktionen ab.
- Der Pages-Build versieht die JavaScript-Dateien und ihre Modulimporte mit der App-Version aus der Fußzeile.
