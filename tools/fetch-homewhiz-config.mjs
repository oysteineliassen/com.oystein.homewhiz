#!/usr/bin/env node
/*
 * One-time download of the appliance configuration from the HomeWhiz cloud,
 * same calls as the Home Assistant integration (custom_components/homewhiz/api.py).
 * The result is saved in model/ and baked into the app, so the app never talks to the cloud.
 *
 * Usage (PowerShell):
 *   $env:HOMEWHIZ_USER = "you@example.com"
 *   $env:HOMEWHIZ_PASSWORD = "..."
 *   node tools/fetch-homewhiz-config.mjs HwZ_xxxxxxxxxxxx
 *
 * The argument is the BLE name the app logs during pairing (starts with "HwZ").
 * Without it, the script lists the appliances on the account and saves the first washer.
 */

import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGION = 'eu-west-1';
const SERVICE = 'execute-api';
const USER_AGENT = 'HomeWhiz/1.0';
const LANGUAGES = ['en-GB', 'nb-NO'];
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'model');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function login(username, password) {
  const res = await fetch('https://api.arcelikiot.com/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (res.status !== 200 || !body.success || !body.data) {
    throw new Error(`Login failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.data.credentials;
}

// AWS Signature V4 for a GET without body, as in api.py make_api_get_request
async function signedGet(host, credentials, uri, query = '') {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${credentials.sessionToken}\n`;
  const signedHeaders = 'host;x-amz-date;x-amz-security-token';
  const canonicalRequest = ['GET', uri, query, canonicalHeaders, signedHeaders, sha256('')].join('\n');
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  let key = hmac(`AWS4${credentials.secretKey}`, dateStamp);
  key = hmac(key, REGION);
  key = hmac(key, SERVICE);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  const body = await getJson(`https://${host}${uri}${query ? `?${query}` : ''}`, {
    'x-amz-date': amzDate,
    'x-amz-security-token': credentials.sessionToken,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  });
  if (body.success === false) throw new Error(`API error: ${JSON.stringify(body)}`);
  return body;
}

async function fetchAppliances(credentials) {
  const homes = await signedGet('smarthome.arcelikiot.com', credentials, '/my-homes');
  const appliances = [];
  for (const home of homes.data) {
    const details = await signedGet('smarthome.arcelikiot.com', credentials, `/my-homes/${home.id}`);
    appliances.push(...details.data.appliances);
  }
  return appliances;
}

async function fetchContents(credentials, applianceId, lang) {
  const query = `applianceId=${encodeURIComponent(applianceId)}&ctype=CONFIGURATION%2CLOCALIZATION&lang=${lang}&testMode=true`;
  const index = await signedGet('api.arcelikiot.com', credentials, '/procam/contents', query);
  const results = [];
  for (const c of index.data.results) {
    const url = `https://s3-eu-west-1.amazonaws.com/procam-contents/${c.ctype}S/${c.cid}/v${c.ver}/${c.cid}.${c.lang}.json`;
    results.push({ ...c, url, body: await getJson(url) });
  }
  return results;
}

async function main() {
  const username = process.env.HOMEWHIZ_USER;
  const password = process.env.HOMEWHIZ_PASSWORD;
  const bleName = process.argv[2];
  if (!username || !password) {
    console.error('Set HOMEWHIZ_USER and HOMEWHIZ_PASSWORD first (see top of this file).');
    process.exit(1);
  }

  let applianceId = null;
  if (bleName) {
    // Same as make_id_exchange_request: the BLE name without its first 4 characters is the hsmid
    const hsmid = bleName.slice(4);
    const exchange = await getJson(`https://idexchange.arcelikiot.com/GetApplianceId?hsmid=${encodeURIComponent(hsmid)}`);
    applianceId = exchange.appId;
    console.log(`ID exchange: ${bleName} -> applianceId ${applianceId}`);
  }

  const credentials = await login(username, password);
  console.log('Logged in');

  const appliances = await fetchAppliances(credentials);
  for (const a of appliances) {
    console.log(`Appliance ${a.applianceId}: name="${a.name}" model=${a.model} type=${a.applianceType} brand=${a.brand} connectivity=${a.connectivity} platform=${a.platformType}`);
  }
  const appliance = applianceId
    ? appliances.find((a) => a.applianceId === applianceId)
    : appliances.find((a) => a.applianceType === 1);
  if (!applianceId) applianceId = appliance && appliance.applianceId;
  if (!applianceId) throw new Error('No washer found on the account; pass the BLE name as argument');

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'appliance.json'), `${JSON.stringify({ applianceId, bleName, appliance }, null, 2)}\n`);

  for (const lang of LANGUAGES) {
    let contents;
    try {
      contents = await fetchContents(credentials, applianceId, lang);
    } catch (err) {
      console.warn(`Could not fetch ${lang}: ${err.message}`);
      continue;
    }
    for (const c of contents) {
      const file = c.ctype === 'CONFIGURATION' ? 'config.json' : `localization.${c.lang}.json`;
      await writeFile(join(OUT_DIR, file), `${JSON.stringify(c.body, null, 2)}\n`);
      console.log(`Saved model/${file} (${c.ctype} ${c.cid} v${c.ver} ${c.lang})`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
