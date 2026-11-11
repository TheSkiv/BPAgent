// Theme (light/dark) and language (EN/LT) for every PortSystem page, plus the corner switch.
// Loaded in <head> so the saved theme applies before the page paints. English text is the key;
// I18N.t() returns the Lithuanian text when LT is chosen, or the English text when there is none
// (so server messages built from live data simply stay English).
(function () {
  const LT = {
    // ── Shared / top bar ──
    'Truck desk': 'Sunkvežimių pultas',
    'Trucks': 'Sunkvežimiai',
    'Lots & owners': 'Partijos ir savininkai',
    'Find a truck': 'Rasti sunkvežimį',
    'Find a truck — plate, company, cargo, PRK': 'Rasti sunkvežimį — numeris, įmonė, krovinys, PRK',
    'Checked in the background every few minutes': 'Tikrinama fone kas kelias minutes',
    'Mail …': 'Paštas …',
    'Mail': 'Paštas',
    'Mail down': 'Paštas neveikia',
    'Mail ?': 'Paštas ?',
    'Alerts off': 'Pranešimai išjungti',
    'Alerts on': 'Pranešimai įjungti',
    'Sound and a notification when something new needs you': 'Garsas ir pranešimas, kai atsiranda kas nors nauja, ko reikia jums',
    'Open KIPIS': 'Atidaryti KIPIS',
    'Check mail': 'Tikrinti paštą',
    'Fetches new order emails; new trucks are then filed automatically': 'Parsiunčia naujus užsakymų laiškus; naujų sunkvežimių PRK tada pildomi automatiškai',
    'Close': 'Uždaryti',
    'Dark theme': 'Tamsi tema',
    'Light theme': 'Šviesi tema',
    'Language': 'Kalba',

    // ── Side column ──
    'Runs by itself': 'Veikia savaime',
    'Checking mail': 'Pašto tikrinimas',
    'New order emails are read every few minutes.': 'Nauji užsakymų laiškai skaitomi kas kelias minutes.',
    'Filing PRK drafts': 'PRK juodraščių pildymas',
    'Files every ready truck now, oldest first': 'Dabar užpildo visus paruoštus sunkvežimius, pradedant seniausiu',
    'File all now': 'Pildyti visus',
    'Within a minute of a truck being ready, 08–18.': 'Per minutę nuo to, kai sunkvežimis paruoštas, 08–18 val.',
    'Spotting your Pateikti': '„Pateikti“ stebėjimas',
    "Reads KIPIS's PRK list for drafts you have submitted": 'Perskaito KIPIS PRK sąrašą ir randa jūsų pateiktus juodraščius',
    'Check now': 'Tikrinti dabar',
    'A minute after you press Pateikti, and every 5 min, 08–18.': 'Praėjus minutei po „Pateikti“ ir kas 5 min., 08–18 val.',
    'Deleting unused drafts': 'Juodraščių šalinimas',
    "Deletes every unsubmitted PortSystem draft now, today's included. Other people's drafts are never touched.": 'Dabar pašalina visus nepateiktus PortSystem juodraščius, ir šiandienos. Kitų žmonių juodraščiai niekada neliečiami.',
    'Delete all now': 'Šalinti visus',
    "By itself once a day: drafts 2+ days old. The button: all of ours, today's too.": 'Savaime kartą per dieną: 2 ir daugiau dienų senumo juodraščiai. Mygtukas: visi mūsų, ir šiandienos.',
    'One truck by hand': 'Vienas sunkvežimis rankiniu būdu',
    'Plate, e.g. ABC123//XY456': 'Numeris, pvz., ABC123//XY456',
    'File': 'Pildyti',
    'Files the PRK draft for this plate now.': 'Dabar užpildo šio numerio PRK juodraštį.',
    'Or the next one in line': 'Arba kitą eilėje',
    'Mail not connected': 'Paštas neprijungtas',
    'The mailbox did not answer. Check the network and the mail settings in .env.': 'Pašto dėžutė neatsakė. Patikrinkite tinklą ir pašto nustatymus .env faile.',

    // ── Order dialog ──
    'Email': 'Laiškas',
    'Cargo': 'Krovinys',
    'Weight, kg': 'Svoris, kg',
    'Gross weight, kg — goes into the PRK as written': 'Bruto svoris, kg — į PRK įrašomas taip, kaip parašyta',
    'Bulk cargo': 'Birus krovinys',
    'Save changes': 'Išsaugoti pakeitimus',
    'Empty = {g} (weight + 1 kg per {bag} kg bag)': 'Tuščia = {g} (svoris + 1 kg kiekvienam {bag} kg maišui)',
    'Why it stopped: {note}': 'Kodėl sustojo: {note}',
    'Loading the email…': 'Įkeliamas laiškas…',
    'The source email is not stored for this truck.': 'Šio sunkvežimio pradinis laiškas neišsaugotas.',
    '(empty email)': '(tuščias laiškas)',
    'attachment': 'priedas',
    'Saving…': 'Išsaugoma…',
    'Saved': 'Išsaugota',
    ' Filing it again now.': ' Dabar pildoma iš naujo.',
    'Not saved — order not found.': 'Neišsaugota — užsakymas nerastas.',

    // ── Dispatch dialog ──
    'Dispatch email': 'Laiškas terminalui',
    'Loading order': 'Pakrovimo užsakymas',
    'Terminal': 'Terminalas',
    'Attachment': 'Priedas',
    'To': 'Kam',
    'Cc': 'Kopija',
    'Subject': 'Tema',
    'Text': 'Tekstas',
    'Send email': 'Siųsti laišką',
    'Writing the email…': 'Rašomas laiškas…',
    'None — the PRK follows the loaded weight': 'Nėra — PRK bus pateiktas po pakrauto svorio',
    'Getting the PRK PDF from KIPIS…': 'Gaunamas PRK PDF iš KIPIS…',
    'Checking whether this truck was already emailed today…': 'Tikrinama, ar šiam sunkvežimiui šiandien jau siųstas laiškas…',
    'Getting the PRK PDF from KIPIS and checking the inbox — Send turns on in a few seconds. You can read and edit the text meanwhile.': 'Gaunamas PRK PDF iš KIPIS ir tikrinama pašto dėžutė — „Siųsti laišką“ įsijungs po kelių sekundžių. Tuo metu galite skaityti ir taisyti tekstą.',
    'Already sent from here at {time}.': 'Jau išsiųsta iš čia {time}.',
    'An email for this truck already went to the terminal today — check before sending again.': 'Šiam sunkvežimiui laiškas terminalui šiandien jau išsiųstas — patikrinkite prieš siųsdami dar kartą.',
    'Missing: {list} — add it to the text.': 'Trūksta: {list} — įrašykite į tekstą.',
    'This truck was already emailed to the terminal today. Send again?': 'Šiam sunkvežimiui laiškas terminalui šiandien jau išsiųstas. Siųsti dar kartą?',
    'Sending…': 'Siunčiama…',
    'Email sent to {list}.': 'Laiškas išsiųstas: {list}.',

    // ── Route stops and truck states ──
    'Order': 'Užsakymas',
    'Draft': 'Juodraštis',
    'Done': 'Atlikta',
    'Gate pass': 'Leidimas',
    'Cancelled': 'Atšaukta',
    'Loading ordered{time} — waiting for the loaded weight': 'Pakrovimas užsakytas{time} — laukiama pakrauto svorio',
    'Order the loading by email': 'Užsakykite pakrovimą laišku',
    'Gets its PRK draft automatically': 'PRK juodraštis bus užpildytas automatiškai',
    'New order': 'Naujas užsakymas',
    'Filing in KIPIS now…': 'Dabar pildoma KIPIS…',
    'Not filed — will be tried again automatically': 'Neužpildyta — bus bandoma dar kartą automatiškai',
    'Not filed': 'Neužpildyta',
    'Check the draft in KIPIS and press Pateikti': 'Patikrinkite juodraštį KIPIS ir paspauskite „Pateikti“',
    'Set Pakuotės rūšis to "43, Krepšys" by hand first — it could not be set automatically.': 'Pirmiausia rankiniu būdu nustatykite Pakuotės rūšį „43, Krepšys“ — automatiškai nepavyko.',
    'Form filled but not saved — save it in KIPIS': 'Forma užpildyta, bet neišsaugota — išsaugokite ją KIPIS',
    'Email sent {time} — closes at the next mail check': 'Laiškas išsiųstas {time} — užsidarys per kitą pašto patikrinimą',
    'Send the dispatch email': 'Išsiųskite laišką terminalui',

    // ── Tabs, rows, buttons ──
    'Needs you': 'Laukia jūsų',
    'System working': 'Sistema dirba',
    'Waiting': 'Laukiama',
    'All': 'Visi',
    'Order loading': 'Užsakyti pakrovimą',
    'File now': 'Pildyti dabar',
    'Try again': 'Bandyti dar kartą',
    'Fix order': 'Taisyti užsakymą',
    'Mark done': 'Pažymėti atliktu',
    'Close this truck by hand': 'Uždaryti šį sunkvežimį rankiniu būdu',
    'Click to name this company': 'Spustelėkite ir įrašykite įmonės pavadinimą',
    'This plate has more than one order today': 'Šis numeris šiandien turi daugiau nei vieną užsakymą',
    'Open the order and its email': 'Atidaryti užsakymą ir jo laišką',
    'from yesterday': 'iš vakar',
    'Cargo not known': 'Krovinys nežinomas',
    'from {vessel}': 'laivas {vessel}',
    '(no subject)': '(be temos)',
    'New sender: {sender}': 'Naujas siuntėjas: {sender}',
    'Trust this sender from now on; their orders get filed automatically': 'Nuo šiol pasitikėti šiuo siuntėju; jo užsakymai bus pildomi automatiškai',
    'Trust this sender': 'Pasitikėti šiuo siuntėju',
    'Accept this email only': 'Priimti tik šį laišką',
    'Ignore this email': 'Nepaisyti šio laiško',
    'Block sender': 'Blokuoti siuntėją',
    'No truck matches “{q}”.': 'Joks sunkvežimis neatitinka „{q}“.',
    'Try the plate without slashes, or the company name.': 'Bandykite numerį be pasvirųjų brūkšnių arba įmonės pavadinimą.',
    'Nothing needs you right now.': 'Šiuo metu niekas jūsų nelaukia.',
    'New orders come in with Check mail and are filed automatically.': 'Nauji užsakymai ateina tikrinant paštą ir pildomi automatiškai.',
    'No trucks here.': 'Čia sunkvežimių nėra.',
    'Could not load the trucks.': 'Nepavyko įkelti sunkvežimių.',
    'Loading trucks…': 'Įkeliami sunkvežimiai…',

    // ── Alerts ──
    'New sender to confirm: {sender}': 'Naujas siuntėjas, kurį reikia patvirtinti: {sender}',
    'KIPIS is logged out — open it and enter the code': 'KIPIS atsijungęs — atidarykite jį ir įveskite kodą',
    '{n} things need you: {list}': 'Jūsų laukia ({n}): {list}',
    'Alerts on — a sound when something new needs you. Keep this tab open.': 'Pranešimai įjungti — pasigirs garsas, kai atsiras kas nors nauja. Laikykite šį skirtuką atidarytą.',

    // ── Confirms and prompts ──
    'Close {plate} by hand?': 'Uždaryti {plate} rankiniu būdu?',
    'this truck': 'šį sunkvežimį',
    'Block this sender for good? Their waiting orders are cancelled.': 'Blokuoti šį siuntėją visam laikui? Jo laukiantys užsakymai bus atšaukti.',
    'Company name for this sender:': 'Šio siuntėjo įmonės pavadinimas:',
    "Delete ALL of PortSystem's unsubmitted (Ruošiamas) PRK drafts now — today's included?\n\nThis also deletes drafts for trucks still waiting for your Pateikti. Drafts already submitted, and drafts made by other people, are never touched.\n\nThis cannot be undone.":
      'Dabar pašalinti VISUS nepateiktus (Ruošiamas) PortSystem PRK juodraščius, ir šiandienos?\n\nBus pašalinti ir juodraščiai sunkvežimių, kurie dar laukia jūsų „Pateikti“. Jau pateikti juodraščiai ir kitų žmonių juodraščiai niekada neliečiami.\n\nTo atšaukti negalima.',

    // ── Filing ──
    'Type a truck plate first.': 'Pirmiausia įveskite sunkvežimio numerį.',
    'Filing the PRK for {plate} — about a minute…': 'Pildomas {plate} PRK — apie minutę…',
    '{plate} already has a PRK in KIPIS ({prk}) — nothing filed.': '{plate} jau turi PRK KIPIS sistemoje ({prk}) — nieko nepildyta.',
    '{plate} not filed: {why}. Confirm the lot owners, then try again.': '{plate} neužpildyta: {why}. Patvirtinkite partijų savininkus ir bandykite dar kartą.',
    '{plate} not filed: {why}': '{plate} neužpildyta: {why}',
    '{plate}: PRK draft {prk} saved — check it in KIPIS and press Pateikti.': '{plate}: PRK juodraštis {prk} išsaugotas — patikrinkite jį KIPIS ir paspauskite „Pateikti“.',
    '{plate}: form filled (test mode) — not saved.': '{plate}: forma užpildyta (bandomasis režimas) — neišsaugota.',
    'Network error: {msg}': 'Ryšio klaida: {msg}',
    'Filing the next truck in line…': 'Pildomas kitas sunkvežimis eilėje…',
    'No truck is waiting to be filed.': 'Nėra sunkvežimių, laukiančių pildymo.',
    '{plate} already has a PRK ({prk}).': '{plate} jau turi PRK ({prk}).',
    '{plate}: PRK draft {prk} saved.': '{plate}: PRK juodraštis {prk} išsaugotas.',
    'Filing every ready truck — about a minute per truck…': 'Pildomi visi paruošti sunkvežimiai — apie minutę kiekvienam…',
    '{n} saved ({list})': 'išsaugota {n} ({list})',
    '{n} already filed': 'jau užpildyta {n}',
    '{n} not filed': 'neužpildyta {n}',
    '{n} failed': 'nepavyko {n}',
    'stopped: {why}': 'sustabdyta: {why}',
    'No ready trucks to file.': 'Nėra paruoštų sunkvežimių pildymui.',

    // ── Mail ──
    'Checking mail…': 'Tikrinamas paštas…',
    'Mail is not set up — check the mail settings in .env.': 'Paštas nesukonfigūruotas — patikrinkite pašto nustatymus .env faile.',
    '1 new truck': '1 naujas sunkvežimis',
    '{n} new trucks': 'naujų sunkvežimių: {n}',
    'No new trucks': 'Naujų sunkvežimių nėra',
    'nothing new': 'nieko naujo',
    "{n} closed by the terminal's copy": 'uždaryta pagal terminalo kopiją: {n}',
    '{n} cargo filled in': 'įrašyta krovinių: {n}',
    'Check by hand — has plates but was not read as an order: {list}': 'Patikrinkite rankiniu būdu — yra numerių, bet neperskaityta kaip užsakymas: {list}',
    ' — filing them now.': ' — dabar pildomi.',
    'Every {n} min, day and night.': 'Kas {n} min., dieną ir naktį.',
    'Automatic check is off — use Check mail.': 'Automatinis tikrinimas išjungtas — naudokite „Tikrinti paštą“.',
    '{time}: check failed — {err}': '{time}: patikrinti nepavyko — {err}',
    'Last check {time}: {what}.': 'Paskutinis patikrinimas {time}: {what}.',
    'Check by hand — has plates, not read as an order:': 'Patikrinkite rankiniu būdu — yra numerių, bet neperskaityta kaip užsakymas:',
    'I have checked them': 'Patikrinau',

    // ── KIPIS ──
    'KIPIS logged in': 'KIPIS prisijungta',
    'KIPIS not open': 'KIPIS neatidarytas',
    'KIPIS not answering': 'KIPIS neatsako',
    'Opening KIPIS — enter the code there if it asks…': 'Atidaromas KIPIS — jei paprašys, įveskite kodą ten…',
    'KIPIS is open and logged in.': 'KIPIS atidarytas ir prisijungta.',

    // ── Auto runs ──
    '{time}: skipped — {why}': '{time}: praleista — {why}',
    'Last run {time}: {n} saved': 'Paskutinis paleidimas {time}: išsaugota {n}',
    'Last check {time}: {what}': 'Paskutinis patikrinimas {time}: {what}',
    '{plates} submitted': 'pateikta: {plates}',
    'Reading the PRK list in KIPIS…': 'Skaitomas KIPIS PRK sąrašas…',
    '{n} of ours under 2 days old (the daily run waits; the button takes them)': 'mūsų, jaunesnių nei 2 dienos: {n} (kasdienis paleidimas palaukia; mygtukas juos pašalina)',
    '{n} by other people (never touched)': 'kitų žmonių: {n} (niekada neliečiami)',
    'Last run {time}: {n} deleted': 'Paskutinis paleidimas {time}: pašalinta {n}',
    'kept {kept}': 'palikta: {kept}',
    'stopped at {plate}': 'sustota ties {plate}',
    'Not done — {msg}': 'Neatlikta — {msg}',
    'Not run — {msg}': 'Nepaleista — {msg}',
    'Reading KIPIS and deleting…': 'Skaitomas KIPIS ir šalinama…',
    '1 lot to confirm': '1 partiją patvirtinti',
    '{n} lots to confirm': 'partijų patvirtinti: {n}',
    '1 company to set': '1 įmonę nustatyti',
    '{n} companies to set': 'įmonių nustatyti: {n}',
    'all set →': 'viskas nustatyta →',

    // ── Fixed server messages ──
    'KIPIS is not open — press Open KIPIS (and enter the MFA code) first. No order was touched.': 'KIPIS neatidarytas — pirmiausia paspauskite „Atidaryti KIPIS“ (ir įveskite MFA kodą). Joks užsakymas neliestas.',
    'KIPIS is logged out — press Open KIPIS and enter the MFA code. No order was touched.': 'KIPIS atsijungęs — paspauskite „Atidaryti KIPIS“ ir įveskite MFA kodą. Joks užsakymas neliestas.',
    'KIPIS did not answer — check the network, then try again. No order was touched.': 'KIPIS neatsakė — patikrinkite tinklą ir bandykite dar kartą. Joks užsakymas neliestas.',
    'Already running. Wait for the current job.': 'Jau vykdoma. Palaukite, kol baigsis dabartinis darbas.',
    'Already running. Wait for current job to finish.': 'Jau vykdoma. Palaukite, kol baigsis dabartinis darbas.',
    'Already running.': 'Jau vykdoma.',
    'Another KIPIS job is running — try again in a moment.': 'Vykdomas kitas KIPIS darbas — bandykite po akimirkos.',
    'Another KIPIS job is running.': 'Vykdomas kitas KIPIS darbas.',
    'A mail check is already in progress — try again in a moment.': 'Paštas jau tikrinamas — bandykite po akimirkos.',
    'Open the email preview again — the PRK PDF is not loaded.': 'Atidarykite laiško peržiūrą iš naujo — PRK PDF neįkeltas.',
    'Order not found': 'Užsakymas nerastas',
    'The order has no PRK number': 'Užsakymas neturi PRK numerio',
    'Plate already filed (marked done). Unmark it first to re-run.': 'Šis numeris jau užpildytas (pažymėtas atliktu). Norėdami pildyti iš naujo, pirmiausia nuimkite žymą.',
    'No ready non-bulk orders in the queue.': 'Eilėje nėra paruoštų nebirių užsakymų.',
    'Missing plate value': 'Neįvestas numeris',
    'Subject and text are required': 'Reikia temos ir teksto',
    'no lot of this cargo is in our storage places (Ro-Ro or Konteinerių terminalas)': 'mūsų sandėliavimo vietose (Ro-Ro ar Konteinerių terminalas) nėra šio krovinio partijos',
    'the order has no company — name the sender on the dashboard': 'užsakymas neturi įmonės — įrašykite siuntėjo įmonę pulte',

    // ── Lots & owners page ──
    'Who owns each lot': 'Kam priklauso kiekviena partija',
    'lots.hint.owners': 'Sunkvežimis kraunamas tik iš savo savininko partijų. Savininkas pasiūlomas pagal sandėlio ataskaitas (žalias apvadas) — patikrinkite ir paspauskite „Patvirtinti“. Galite bet kada pakeisti. <b>#</b> nustato pakrovimo eilę (1 = pirma); palikus tuščią, sunkvežimiai baigia jau kraunamą partiją, tada seniausią.',
    'Find lots in KIPIS': 'Rasti partijas KIPIS',
    'lots.hint.scan': 'Įveskite krovinio žodį (<i>amonio</i>, <i>TSP</i>, <i>axan</i>), kad mūsų sandėlio partijos būtų įtrauktos į sąrašą aukščiau — patogu, kai laivas ką tik iškrautas. KIPIS turi būti atidarytas.',
    'Cargo word': 'Krovinio žodis',
    'Find lots': 'Rasti partijas',
    'Companies': 'Įmonės',
    'lots.hint.companies': 'Kieno krovinį krauna kiekviena užsakanti įmonė: jos pavadinimas Helm/Yara release sąrašuose (susiejama automatiškai, kai pavadinimai sutampa); arba, jei ji neturi savo release, pardavėjas, iš kurio ji perka (Transwina → Helm); ir ar ji krauna ir savo krovinį (Agrokoncernas).',
    'Company': 'Įmonė',
    'Buyer in the release lists': 'Pirkėjas release sąrašuose',
    'Buys from': 'Perka iš',
    'Own cargo': 'Savas krovinys',
    'Receiver country': 'Gavėjo šalis',
    'Put on the PRK (Gavėjas → Valstybė) when KIPIS requires it and the lot leaves it empty': 'Įrašoma į PRK (Gavėjas → Valstybė), kai KIPIS to reikalauja, o partijoje ji nenurodyta',
    "Releases (Helm release'ai, Yara perdavimai)": "Išleidimai (Helm release'ai, Yara perdavimai)",
    'Seller': 'Pardavėjas',
    'Buyer': 'Pirkėjas',
    'Product': 'Produktas',
    'Vessel': 'Laivas',
    'Left': 'Liko',
    '— owner —': '— savininkas —',
    '(vessel unknown)': '(laivas nežinomas)',
    '{n} to confirm': 'patvirtinti: {n}',
    'Confirm': 'Patvirtinti',
    'Lot': 'Partija',
    'KIPIS name': 'Pavadinimas KIPIS',
    'In storage': 'Sandėlyje',
    'Owner': 'Savininkas',
    'Last seen in KIPIS {when}': 'Paskutinį kartą matyta KIPIS {when}',
    'Trucks/wagons loading from this lot': 'Iš šios partijos kraunami sunkvežimiai/vagonai',
    'Remove this lot from the list (e.g. emptied)': 'Pašalinti šią partiją iš sąrašo (pvz., ištuštinta)',
    '— none —': '— nėra —',
    'Save': 'Išsaugoti',
    'No lots yet — they appear after a PRK run or a search below.': 'Partijų dar nėra — jos atsiranda po PRK pildymo arba paieškos žemiau.',
    'Other vessels ({n}) — not in the stock or release lists': 'Kiti laivai ({n}) — nėra sandėlio ar release sąrašuose',
    ' bulk': ' birus',
    'Pick an owner for every lot first.': 'Pirmiausia pasirinkite savininką kiekvienai partijai.',
    'Remove lot {lot} from the list? A later PRK run or search adds it back if it is still in KIPIS.': 'Pašalinti partiją {lot} iš sąrašo? Vėlesnis PRK pildymas arba paieška ją vėl pridės, jei ji tebėra KIPIS.',
    'Reading KIPIS…': 'Skaitomas KIPIS…',
    '{n} lot(s) on {vessels}': 'partijų: {n}; laivai: {vessels}',
    'no vessel': 'laivo nėra',
  };

  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } };

  const lang = read('lang', 'en') === 'lt' ? 'lt' : 'en';
  let theme = read('theme', 'light') === 'dark' ? 'dark' : 'light';
  document.documentElement.lang = lang;
  document.documentElement.dataset.theme = theme;

  function t(s, vars) {
    let out = (lang === 'lt' && LT[s] !== undefined) ? LT[s] : s;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return out;
  }

  // The page's own static text: text nodes and title/placeholder/aria-label whose English text is
  // in the list, plus elements marked data-i18n="key" whose Lithuanian text holds markup. Called
  // once by each page before it renders anything, so email bodies and cargo names are never touched.
  function translatePage() {
    if (lang !== 'lt') return;
    const norm = s => s.replace(/\s+/g, ' ').trim();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
      const key = norm(n.nodeValue);
      if (key && LT[key] !== undefined) n.nodeValue = n.nodeValue.replace(/\S[\s\S]*\S|\S/, LT[key]);
    }
    for (const el of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v && LT[norm(v)] !== undefined) el.setAttribute(a, LT[norm(v)]);
      }
    }
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = LT[el.getAttribute('data-i18n')];
      if (v !== undefined) el.innerHTML = v;
    }
    document.title = document.title.split(' · ').map(p => t(p)).join(' · ');
  }

  // The corner switch: theme flips at once; language reloads the page in the other language.
  function addSwitch() {
    const css = document.createElement('style');
    css.textContent = `
      .prefs { position: fixed; left: 14px; bottom: 14px; z-index: 40; display: flex; gap: 6px; align-items: center;
        background: var(--paper); border: 1px solid var(--hair); border-radius: 999px; padding: 4px; box-shadow: var(--shadow); }
      .prefs button { font: 600 12px var(--body); border: 0; background: transparent; color: var(--steel);
        padding: 5px 10px; border-radius: 999px; cursor: pointer; min-width: 34px; }
      .prefs button:hover { color: var(--ink); }
      .prefs button[aria-pressed="true"] { background: var(--ink); color: var(--paper); }
      .prefs .sep { width: 1px; height: 18px; background: var(--hair); }
      .prefs .theme { font-size: 15px; line-height: 1; padding: 4px 9px; }
      @media print { .prefs { display: none; } }`;
    document.head.appendChild(css);
    const box = document.createElement('div');
    box.className = 'prefs';
    box.innerHTML = `
      <button class="theme" type="button"></button>
      <span class="sep"></span>
      <span role="group" aria-label="${t('Language')}">
        <button type="button" data-lang="en" aria-pressed="${lang === 'en'}">EN</button><button type="button" data-lang="lt" aria-pressed="${lang === 'lt'}">LT</button>
      </span>`;
    const themeBtn = box.querySelector('.theme');
    const showTheme = () => {
      themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
      const label = t(theme === 'dark' ? 'Light theme' : 'Dark theme');
      themeBtn.title = label; themeBtn.setAttribute('aria-label', label);
    };
    showTheme();
    themeBtn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      write('theme', theme);
      showTheme();
    });
    box.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.lang === lang) return;
      write('lang', b.dataset.lang);
      location.reload();
    }));
    document.body.appendChild(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSwitch);
  else addSwitch();

  window.I18N = { t, translatePage, lang };
})();
