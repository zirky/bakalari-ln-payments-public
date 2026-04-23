const axios = require('axios');
const nodemailer = require('nodemailer');

// 💡 KRITICKÉ: Načtení proměnných z lokálního souboru .env (POUZE PRO LOKÁLNÍ TEST)
require('dotenv').config();

// --- 1. NAČTENÍ PROMĚNNÝCH A KONSTANT ---
// BAKALÁŘI
const BAKALARI_BASE_URL = process.env.BAKALARI_BASE_URL;
const BAKALARI_USERNAME = process.env.BAKALARI_USERNAME;
const BAKALARI_PASSWORD = process.env.BAKALARI_PASSWORD;

// START DATE
const DEFAULT_START_DATE = '2024-01-01';
const START_DATE_ENV = process.env.START_DATE || DEFAULT_START_DATE;

// LNBits & API
const LNBITS_HOST = process.env.LNBITS_HOST || 'https://lnbits.cz';
const LNBITS_WITHDRAW_KEY = process.env.LNBITS_WITHDRAW_KEY;
const LNBITS_WITHDRAW_ENDPOINT = process.env.LNBITS_WITHDRAW_ENDPOINT || '/withdraw/api/v1/links';
const EXCHANGE_RATE_API_URL = process.env.EXCHANGE_RATE_API_URL;

// ODMĚNY V CZK
const REWARD_CONFIG = {
 1: parseFloat(process.env.REWARD_GRADE_1_CZK || 0),
 2: parseFloat(process.env.REWARD_GRADE_2_CZK || 0),
 3: parseFloat(process.env.REWARD_GRADE_3_CZK || 0),
 4: parseFloat(process.env.REWARD_GRADE_4_CZK || 0),
 5: parseFloat(process.env.REWARD_GRADE_5_CZK || 0)
};

// NOTIFIKACE
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_PORT = process.env.SMTP_PORT || 465;

// 💡 KONSTANTY PRO GITHUB VARIABLES PERSISTENCE
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_SLUG = process.env.GITHUB_REPOSITORY;
const STATE_VARIABLE_NAME = 'BAKALARI_STATE';
const [REPO_OWNER, REPO_NAME] = (REPO_SLUG || '/').split('/');

// --- 2. KONTROLA KRITICKÝCH SECRETŮ A SMTP ---
if (!LNBITS_WITHDRAW_KEY || !BAKALARI_USERNAME || !BAKALARI_PASSWORD || !EXCHANGE_RATE_API_URL || !BAKALARI_BASE_URL) {
 console.error("🔴 KRITICKÁ CHYBA: Chybí klíče Bakaláři nebo LNBITS_WITHDRAW_KEY/API URL.");
 process.exit(1);
}
let transporter;
if (SMTP_HOST) {
 // 💡 Zajištění správné konverze portu
 const port = parseInt(SMTP_PORT);
 if (isNaN(port)) {
 console.error("🔴 CHYBA: SMTP_PORT není platné číslo.");
 process.exit(1);
 }
 transporter = nodemailer.createTransport({
 host: SMTP_HOST,
 port: port,
 secure: true,
 auth: { user: SMTP_USER, pass: SMTP_PASS }
 });
}

// --- 3. FUNKCE PRO KOMUNIKACI S BAKALÁŘI ---

async function findWorkingEndpoint(baseUrl) {
 const possiblePrefixes = [
 '', '/bakalari', '/bakaweb', '/webrodice', '/dm', '/mobile'
 ];
 console.log(`DIAGNOSTIKA: Hledám funkční API endpoint na ${baseUrl}...`);

 for (const prefix of possiblePrefixes) {
 const testUrl = `${baseUrl}${prefix}/api/login`;
 const params = new URLSearchParams();
 params.append('client_id', 'ANDR');
 params.append('grant_type', 'password');
 params.append('username', 'test');
 params.append('password', 'test');

 try {
 await axios.post(testUrl, params, {
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
 });
 } catch (error) {
 // Bakaláři vrátí 400/401 pro neúspěšný pokus (dobře), ale 404 pro špatnou cestu.
 if (error.response && (error.response.status === 400 || error.response.status === 401)) {
 const foundApiBase = `${baseUrl}${prefix}/api`;
 console.log(`✅ NALEZEN FUNKČNÍ ENDPOINT: ${foundApiBase}`);
 return foundApiBase;
 }
 }
 }
 throw new Error("API endpoint nenalezen na žádné známé cestě.");
}

async function authenticateBakalari(username, password, apiBaseUrl) {
 const authUrl = `${apiBaseUrl}/login`;
 const params = new URLSearchParams();
 params.append('client_id', 'ANDR');
 params.append('grant_type', 'password');
 params.append('username', username);
 params.append('password', password);

 try {
 const response = await axios.post(authUrl, params, {
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
 });
 return response.data?.access_token;
 } catch (error) {
 throw new Error(`Přihlášení selhalo: ${error.message}. Kód chyby: ${error.response?.status || 'N/A'}`);
 }
}

async function fetchMarksViaApi(filterDate) {
 console.log(`DIAGNOSTIKA: Spouštím proces získání známek...`);

 const apiBaseUrl = await findWorkingEndpoint(BAKALARI_BASE_URL);
 const token = await authenticateBakalari(BAKALARI_USERNAME, BAKALARI_PASSWORD, apiBaseUrl);

 console.log("DIAGNOSTIKA: Bakaláři přihlášení úspěšné.");

 const marksUrl = `${apiBaseUrl}/3/marks`;

 try {
 const response = await axios.get(marksUrl, {
 headers: { 'Authorization': `Bearer ${token}` }
 });

 let newMarks = [];
 const subjects = response.data?.Subjects || response.data?.Marks || [];

 subjects.forEach(subject => {
 const subjectName = subject.Caption || subject.Name || subject.SubjectName || 'Neznámý předmět';
 // 💡 Předáváme filterDate do processMark
 (subject.Marks || []).forEach(mark => processMark(mark, subjectName, filterDate, newMarks));
 });

 console.log(`DIAGNOSTIKA: Nalezeno ${newMarks.length} nových známek.`);
 return { marks: newMarks };

 } catch (error) {
 console.error('🔴 CHYBA PŘI ZÍSKÁVÁNÍ ZNÁMEK:', error.message);
 throw error;
 }
}

// 💡 Přejmenováno pro lepší pochopení
function processMark(mark, subjectName, filterDate, collection) {
 const markDate = new Date(mark.Date || mark.MarkDate);

 // Zahrnuje známky striktně NOVĚJŠÍ než datum poslední kontroly
 if (markDate > filterDate && mark.MarkText) {
 collection.push({
 date: markDate,
 value: mark.MarkText.trim(),
 subject: subjectName
 });
 }
}

// --- 4. FUNKCE PRO PERSISTENCI STAVU (GITHUB) ---

async function loadStateFromVariable() {
 console.log(`DIAGNOSTIKA: Pokouším se načíst stav z GitHub Variable...`);

 const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/variables/${STATE_VARIABLE_NAME}`;

 if (!GITHUB_TOKEN) {
 console.warn('⚠️ CHYBA: GITHUB_TOKEN není nastaven. Nelze načíst stav. Používám výchozí stav.');
 return { last_checked: START_DATE_ENV, running_balance_czk: 0 };
 }

 try {
 const response = await axios.get(apiUrl, {
 headers: {
 'Authorization': `token ${GITHUB_TOKEN}`,
 'Accept': 'application/vnd.github.v3+json'
 }
 });

 const stateJson = response.data.value;
 console.log(`✅ Stav úspěšně načten z Variable.`);
 return JSON.parse(stateJson);

 } catch (error) {
 console.warn(`⚠️ CHYBA PŘI NAČÍTÁNÍ STAVU: ${error.message}. Spouštím s výchozím datem.`);
 return {
 last_checked: START_DATE_ENV,
 running_balance_czk: 0
 };
 }
}

async function saveStateToVariable(state) {
 console.log(`DIAGNOSTIKA: Ukládám stav do GitHub Variable...`);
 const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/variables/${STATE_VARIABLE_NAME}`;

 if (!GITHUB_TOKEN) {
 console.error('🔴 KRITICKÁ CHYBA: GITHUB_TOKEN není nastaven. Stav nebyl uložen!');
 throw new Error("Kritická chyba: GITHUB_TOKEN není nastaven. Nepodařilo se uložit stav.");
 }

 const data = {
 name: STATE_VARIABLE_NAME,
 value: JSON.stringify(state)
 };

 try {
 // Používáme PATCH pro aktualizaci existující proměnné
 await axios.patch(apiUrl, data, {
 headers: {
 'Authorization': `token ${GITHUB_TOKEN}`,
 'Accept': 'application/vnd.github.v3+json'
 }
 });
 console.log(`✅ Nový stav uložen do GitHub Variable.`);
 } catch (error) {
 console.error('🔴 CHYBA PŘI UKLÁDÁNÍ STAVU DO VARIABLES:', error.message);
 throw new Error("Kritická chyba: Nepodařilo se uložit stav do Variables.");
 }
}

// --- 5. OSTATNÍ FUNKCE ---

function mapGradeToNumeric(gradeString) {
 return parseInt(gradeString.replace(/[\\+\\-]/g, ''), 10);
}

function computeCzkChangeFromMarks(marks) {
 let czkTotal = 0;

 marks.forEach(mark => {
 const numericGrade = mapGradeToNumeric(mark.value);
 const reward = REWARD_CONFIG[numericGrade];

 if (reward !== undefined) {
 czkTotal += reward;
 } else {
 console.warn(`Upozornění: Pro známku ${mark.value} neexistuje definovaná odměna.`);
 }
 });
 return czkTotal;
}

async function getBtcPerCzk() {
 try {
 const response = await axios.get(EXCHANGE_RATE_API_URL);
 const czkRate = response.data?.bitcoin?.czk;
 if (!czkRate || typeof czkRate !== 'number') {
 throw new Error("Neplatná odpověď z API kurzu.");
 }
 console.log(`DIAGNOSTIKA: 1 BTC = ${czkRate} CZK.`);
 return czkRate;
 } catch (error) {
 console.error('🔴 CHYBA ZÍSKÁNÍ KURZU:', error.message);
 // Návrat k defaultní hodnotě v případě chyby, jak bylo zamýšleno
 return 1500000;
 }
}

function czkToSats(czkAmount, czkPerBtc) {
 const satsPerBtc = 100000000;
 const btcAmount = czkAmount / czkPerBtc;
 return Math.round(btcAmount * satsPerBtc);
}

async function createWithdrawVoucher(czkTotal, czkPerBtc) {
 const totalSats = czkToSats(czkTotal, czkPerBtc);
 const apiValue = totalSats;

 console.log(`DIAGNOSTIKA: Odměna: ${czkTotal.toFixed(2)} CZK. Přepočet: ${totalSats} sats. Hodnota odesílaná API: ${apiValue}.`);

 if (totalSats <= 0) {
 console.log('DIAGNOSTIKA: Celková odměna je 0 nebo záporná. Voucher nebude vytvořen.');
 return { success: true, message: "Bez platby." };
 }

 const apiUrl = `${LNBITS_HOST}${LNBITS_WITHDRAW_ENDPOINT}`;

 const voucherData = {
 title: `Odměna za známky (${czkTotal.toFixed(2)} CZK)`,
 min_withdrawable: apiValue,
 max_withdrawable: apiValue,
 uses: 1,
 is_unique: true,
 wait_time: 1
 };

 try {
 const response = await axios.post(apiUrl, voucherData, {
 headers: {
 'X-Api-Key': LNBITS_WITHDRAW_KEY,
 'Content-Type': 'application/json'
 }
 });

 const lnurl = response.data?.lnurl;

 if (!lnurl) {
 throw new Error("API nevrátilo platný LNURL.");
 }

 console.log('✅ VOUCHER ÚSPĚŠNĚ VYTVOŘEN!');

 if (transporter) {
 await sendVoucherEmail(lnurl, czkTotal, totalSats);
 } else {
 console.warn('⚠️ E-mailová notifikace přeskočena: Chybí nastavení SMTP.');
 }

 return { success: true, lnurl: lnurl };

 } catch (err) {
 console.error('🔴 CHYBA PŘI TVORBĚ VOUCHERU:', err.response?.data || err.message);
 throw new Error(`Volání Withdraw API selhalo: Request failed with status code ${err.response?.status || 500}`);
 }
}

async function sendVoucherEmail(lnurl, czkTotal, totalSats) {
 const qrCodeUrl = `${LNBITS_HOST}/api/v1/qrcode?data=${encodeURIComponent(lnurl)}`;

 const emailBody = `


Ahoj,

Automatický systém Bakaláři zaznamenal Tvé nové známky a vypočítal odměnu.

Celková odměna: **${czkTotal.toFixed(2)} CZK**

V přepočtu na krypto: **${totalSats} sats**

### Potvrzení o výběru

Tento Lightning voucher je připraven k výběru. Jakmile bude kód použit, peníze budou okamžitě odeslány do Tvé peněženky.

Stav voucheru si můžeš zkontrolovat na ${LNBITS_HOST}.

Pro vybrání odměny naskenuj tento QR kód ve své Lightning peněžence:
Nebo použij tento odkaz:

${lnurl}

Systém Bakaláři/LNbits.

 `;

 try {
 await transporter.sendMail({
 from: `"${SMTP_USER}" <${SMTP_USER}>`,
 to: NOTIFICATION_EMAIL,
 subject: `💰 Nová odměna: ${totalSats} sats (${czkTotal.toFixed(0)} CZK) - K VYZVEDNUTÍ`,
 html: emailBody
 });
 console.log(`✅ E-mail s voucherem odeslán (Odměna: ${totalSats} sats).`);
 } catch (error) {
 console.error('🔴 CHYBA PŘI ODESÍLÁNÍ E-MAILU:', error.message);
 }
}

// --- 6. HLAVNÍ FUNKCE SKRIPTU (S OPRAVENOU LOGIKOU TRVALÉHO ZŮSTATKU) ---
async function main() {
 console.log('DIAGNOSTIKA: Vstup do main funkce. Spouštím kontrolu prospektu...');

 try {
 let lastCheckDate;
 let runningBalanceCzk;
 let newCheckDate = new Date(); // Čas provedení aktuální kontroly

 // 1. NAČTENÍ PŘEDCHOZÍHO ZŮSTATKU A DATA KONTROLY Z VARIABLE
 const variableState = await loadStateFromVariable();

 // Nastavíme hodnoty z načteného stavu
 lastCheckDate = new Date(variableState.last_checked);
 runningBalanceCzk = parseFloat(variableState.running_balance_czk) || 0;

 console.log(`DIAGNOSTIKA: Načten stav: Datum kontroly od ${lastCheckDate.toISOString()}, Zůstatek: ${runningBalanceCzk.toFixed(2)} CZK.`);

 // Přidání 1ms k datu poslední kontroly zajišťuje, že se nebudou znovu načítat známky s přesně stejným časem
 const filterDate = new Date(lastCheckDate.getTime() + 1);

 const marksData = await fetchMarksViaApi(filterDate);

 // 2. VÝPOČET ZMĚNY Z NOVÝCH ZNÁMEK
 const czkChangeFromMarks = computeCzkChangeFromMarks(marksData.marks);

 if (marksData.marks.length === 0) {
 console.log("DIAGNOSTIKA: Žádné nové známky k proplacení.");
 // Ukládáme stávající dluh/zůstatek a aktuální čas kontroly (newCheckDate)
 await saveStateToVariable({
 last_checked: newCheckDate.toISOString(),
 running_balance_czk: runningBalanceCzk
 });
 return;
 }

 // 3. KRITICKÁ KROK: VÝPOČET NOVÉHO CELKOVÉHO ZŮSTATKU
 const newRunningBalance = runningBalanceCzk + czkChangeFromMarks;
 let paymentAmountCzk = 0;
 let balanceToSave = newRunningBalance; // VÝCHOZÍ: uložíme nový zůstatek (pokud platba selže)

 if (newRunningBalance > 0) {
 // Zůstatek je kladný -> proplatíme ho celý
 paymentAmountCzk = newRunningBalance;
 console.log(`DIAGNOSTIKA: Původní: ${runningBalanceCzk.toFixed(2)} CZK. Nová změna: ${czkChangeFromMarks.toFixed(2)} CZK. Celková odměna k platbě: ${paymentAmountCzk.toFixed(2)} CZK.`);
 } else {
 // Zůstatek je nula nebo záporný -> neplatíme a dluh/zůstatek uložíme
 console.log(`DIAGNOSTIKA: Původní: ${runningBalanceCzk.toFixed(2)} CZK. Nová změna: ${czkChangeFromMarks.toFixed(2)} CZK. Nový dluh k uložení: ${balanceToSave.toFixed(2)} CZK. Platba se neuskuteční.`);
 }

 // 4. PLATBA (POUZE, POKUD paymentAmountCzk > 0)
 let paymentSuccessful = false;

 if (paymentAmountCzk > 0) {
 try {
 const czkPerBtc = await getBtcPerCzk();
 const voucherResult = await createWithdrawVoucher(paymentAmountCzk, czkPerBtc);

 if (voucherResult.success) {
 paymentSuccessful = true;
 balanceToSave = 0; // Platba proběhla → zůstatek vynulujeme
 console.log('✅ Platba úspěšná.');
 }
 } catch (paymentError) {
 console.error('🔴 CHYBA PŘI PLATBĚ:', paymentError.message);
 console.log(`⚠️ Zůstatek ${newRunningBalance.toFixed(2)} CZK NEBYL proplacen. Ukládám pro další pokus.`);
 // balanceToSave zůstává newRunningBalance (původní + nové známky)
 }
 }

 // 5. ULOŽENÍ STAVU – VŽDY, i když platba selže
 // Datum kontroly se posune vždy (známky už jsou započítané do zůstatku)
 await saveStateToVariable({
 last_checked: newCheckDate.toISOString(),
 running_balance_czk: balanceToSave
 });

 if (!paymentSuccessful && paymentAmountCzk > 0) {
 console.log('DIAGNOSTIKA: Stav uložen, platba bude zkusena znovu příště.');
 } else {
 console.log('DIAGNOSTIKA: Automatizace dokončena. Datum kontroly a zůstatek aktualizovány.');
 }

 } catch (err) {
 console.error('🔴 KRITICKÁ CHYBA v main funkci:', err.message || err);
 // Při kritické chybě (např. Bakaláři API nefunkční) se stav neukládá,
 // aby se příště zkusilo znovu se stejným datem kontroly
 }
}

// --- PŘEJMENOVÁNÍ FUNKCE PRO LOGIKU ---
const computeCzkAmountFromMarks = computeCzkChangeFromMarks;

// --- SPUŠTĚNÍ ---
if (require.main === module) {
 // 💡 Používáme .catch() pro zachycení nekonečných chyb v asynchronní main funkci
 main().catch(error => {
 console.error("🔴 NEKONEČNÁ CHYBA SKRIPTU:", error.message || error);
 process.exit(1);
 });
}
