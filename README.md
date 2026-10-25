# HomeWhiz for Homey Pro

Kobler en HomeWhiz-vaskemaskin (Grundig GWP696110W, produktkode 7177881300) til Homey Pro via Bluetooth LE.
Homey SDK v3, JavaScript, ingen avhengigheter utover Homey selv.

**Status: versjon 2** – pairing via BLE-søk, automatisk gjenoppkobling, dekoding av status,
capabilities, Flow-kort og fjernstart/pause.

Capabilities: status (av/på/kjører/pause/utsatt start), slått på, program, fase, gjenstående tid, vasketemperatur,
sentrifugehastighet, dør låst og Bluetooth tilkoblet.

«Vask er ferdig» utløses ikke når et program avbrytes. «Fase endret» utløses først når en fase har vart i 10 sekunder.

Flow-kort: «Vask er ferdig», «Program startet» og «Fase endret» (triggere), «Maskinen kjører» og
«Fjernstyring er aktivert» (betingelser), «Velg program», «Start programmet» og «Sett programmet på pause» (handlinger).

### Fjernstart og pause

Fjernstyring slås på ved å sette hjulet på **Downloaded Program** og holde **Remote Control** inne i
3 sekunder (byte 32 blir 170). Først da virker start/pause og «Velg program».

Programvelgeren på enhetssiden og «Velg program» skriver program, temperatur og sentrifuge til indeks 36, 37 og 38, og sjekker verdiene
mot det programmet tillater i maskinkonfigurasjonen.
Kommandoen er `02 04 00 04 00 22 01 <verdi>` til `ac01` (indeks 34; 30 = kjør, 40 = pause), og appen venter
inntil 15 sekunder på at maskinen melder den nye tilstanden før den gir feilmelding.

Byte-posisjoner og programliste ligger i `lib/washerModel.js`, hentet fra HomeWhiz-konfigurasjonen
CONFIGURATION_471 v18 for produktkode 7177881300.

## Kjøre appen (Windows / PowerShell)

```powershell
npm i -g homey          # hvis Homey CLI mangler
homey login
homey select            # velg Homey Pro-en din
cd C:\Homeyprojects\com.oystein.homewhiz
npm test                # enhetstester for protokollen (krever ingen Homey)

homey app run           # kjører i Docker på PC-en (Docker Desktop må kjøre)
homey app run --remote  # kjører på selve Homeyen
```

Prøv `homey app run` først. Hvis pairing feiler med en BLE-feil, eller søket ikke finner noen enheter i det hele tatt,
bruk `homey app run --remote`.

Pairing: Enheter → + → HomeWhiz → Vaskemaskin. Ha maskinen på, og koble fra HomeWhiz-appen på telefonen
(maskinen tåler bare én BLE-tilkobling). Under søket logges *alle* BLE-enheter Homey ser, så vi kan se hva maskinen heter
hvis den ikke dukker opp i lista.

## Hva loggen viser

| Linje | Betydning |
|---|---|
| `Connected to HwZ… (…, rssi …)` | Tilkoblet og init-kommando sendt |
| `[debug] GATT service … characteristic …` | Alle GATT-tjenester på maskinen (logges ved hver tilkobling) |
| `RX frame idx=0/1 len=… : …` | Hver rå notification fra `ac02` (av/på med innstillingen «Logg rå BLE-data») |
| `MSG …` | Sammensatt statusmelding (to rammer, 7 byte header fjernet). Logges kun når den endrer seg |
| `Status: state=… program=… phase=…` | Dekodet status (rå verdi i parentes) |
| `Flow trigger: started/phase/finished` | Flow-kort som ble utløst |
| `Machine not reachable (…). Retrying quietly…` | Logges én gang når maskinen forsvinner; deretter stille forsøk hvert minutt |

## Maskinkonfigurasjon fra skyen (engangsjobb)

`tools/fetch-homewhiz-config.mjs` henter konfigurasjonen og norsk/engelsk tekst for nøyaktig din maskin
og lagrer dem i `model/`. Appen bruker aldri skyen selv.

```powershell
$env:HOMEWHIZ_USER = "din@epost.no"
$env:HOMEWHIZ_PASSWORD = "passord"
node tools/fetch-homewhiz-config.mjs HwZ_xxxxxxxx   # BLE-navnet fra pairing-loggen
```

## Funn fra Home Assistant-integrasjonen

Kilde: [rowysock/home-assistant-HomeWhiz](https://github.com/rowysock/home-assistant-HomeWhiz), `custom_components/homewhiz/`.

**BLE-oppsett** (`bluetooth.py`)
- Maskinen annonserer med lokalnavn som starter med `HwZ`.
- Notifications på `0000ac02-0000-1000-8000-00805f9b34fb`, kommandoer skrives til `0000ac01-…`.
- Etter tilkobling: vent 0,5 s, abonner på `ac02`, skriv `02 04 00 04 00 1a 01 03` til `ac01`. Ingen annen handshake/kryptering.
- En statusmelding kommer i to notifications. Byte 4 er rammeindeks (0/1), nyttelasten starter på byte 7.
  Rammer under 10 byte ignoreres.

**Dekoding** (`appliance_controls.py`)
- I den sammensatte meldingen er øverste bit et flagg; verdien er `byte & 0x7f`.
- Posisjonene kommer fra maskinkonfigurasjonen (`wifiArrayIndex`). Alle seks vaskemaskin-konfigurasjonene i HA-testene
  (Grundig, Beko, Arçelik) bruker de samme posisjonene:

| Indeks | Felt | Verdier |
|---|---|---|
| 32 | Fjernstyring aktiv | 170 = på |
| 35 | Tilstand | 10 på, 20 av, 30 kjører, 40 pause, 60 utsatt start |
| 36 | Program | modellavhengig tabell (1 = Bomull i Grundig-konfigurasjonen) |
| 37 | Temperatur | °C, 0 = kaldt |
| 38 | Sentrifuge | × 100 o/min, 0 = ingen, 17 = skyllestopp |
| 46 / 47 | Gjenstående tid | timer / minutter |
| 48 / 49 | Utsatt start | timer / minutter |
| 50 | Fase (substate) | 1 vask, 2 sentrifuge, 3 vanninntak, 4 forvask, 5 skyll, 6 tøymykner, 11 dør låst, 15 ta ut tøy, … |
| 59 | Advarsler (bitmaske) | bit 0 dør åpen, bit 1 mangler vann, bit 2 sikkerhet |
| 63 | Dør låst (øverste bit) | ikke i skykonfigurasjonen, funnet ved testvask 2026-10-20 |

**Skyavhengighet**
- HA henter konfigurasjonen fra skyen ved oppsett (innlogging + AWS-signert API), men bare én gang. Etterpå er alt lokalt over BLE.
- Byte-posisjonene ser ut til å være felles for vaskemaskinene, men program-tabellen (nummer → navn) og hvilke faser som finnes er modellavhengig.
  Derfor skal konfigurasjonen for din modell hentes én gang med skriptet over og bakes inn i appen.

## Ikoner

Ikonene er fra [Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache 2.0), via `@mdi/js` 7.4.47.
Homey fyller alle figurer i et ikon og ignorerer streker, så ikonene må bestå av fylte figurer.
