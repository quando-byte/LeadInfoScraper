/**
 * Leadinfo Stakeholder Scraper
 *
 * Extracts stakeholder data (first name, last name, email, phone) from Leadinfo
 * when you click on leads in the Inbox. Run with: node leadinfo-stakeholders.js
 *
 * Before running: Set CONFIG.credentials.password and adjust CONFIG.maxCompanies.
 * Set CONFIG.ukOnly to false to include all companies (not just UK).
 * Set CONFIG.titleKeywords to [] to include all job titles, or customize the list.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Configuration (replace with your values) ---
const CONFIG = {
    loginUrl: 'https://portal.leadinfo.com/login',
    credentials: {
        email: 'developer@fundingbay.co.uk',
        password: 'wRDUbb4sDa*0w2Ig!',
    },
    selectors: {
        email: 'input[name="email"], input[type="email"], #email',
        password: 'input[name="password"], input[type="password"], #password',
        signIn: 'button[type="submit"], [data-testid="sign-in"], .btn-primary',
    },
    inboxUrl: 'https://portal.leadinfo.com/inbox/today',
    outputFile: 'leadinfo-stakeholders.csv',
    maxCompanies: 10,
    maxContactsPerCompany: 5,
    ukOnly: true,
    titleKeywords: [
        'ceo', 'cto', 'cfo', 'coo', 'chief', 'owner', 'founder', 'partner',
        'director', 'managing director', 'head of', 'vp', 'vice president',
        'manager', 'head', 'lead',
    ],
    headless: false,
    timeout: 60000,
    delayBetweenCompanies: 800,
    delayBetweenContacts: 250,
};

/** Escape a value for CSV (handles quotes and commas) */
function escapeCsvField(value) {
    const str = String(value ?? '').trim();
    return `"${str.replace(/"/g, '""')}"`;
}

/** Check if title matches any of the configured keywords (empty array = include all) */
function matchesTitleFilter(title, keywords) {
    if (!keywords || keywords.length === 0) return true;
    const t = String(title || '').toLowerCase();
    return keywords.some((kw) => t.includes(kw.toLowerCase()));
}

/** Check if a row is a stakeholder (person contact, not a placeholder or CTA) */
function isStakeholderRow(name) {
    const n = String(name || '').trim();
    if (!n || n.length < 2) return false;
    const skip = /^(get|add|request|company|view|show|more|loading|\.\.\.)$/i;
    if (skip.test(n)) return false;
    return true;
}

/** Parse full name into first and last (handles suffixes like FCIPD, Jr, III) */
function parseName(fullName) {
    const suffixes = /\b(FCIPD|Jr\.?|Sr\.?|III|II|IV|PhD|MBA|CPA|CIPD)\s*$/i;
    let name = String(fullName ?? '').trim();
    name = name.replace(suffixes, '').trim();
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return {
        firstName: parts[0],
        lastName: parts.slice(1).join(' '),
    };
}

/** Wait for a short delay */
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** UK indicators for company location (country, region) */
const UK_INDICATORS = [
    'united kingdom',
    ' united kingdom',
    '\u00a0united kingdom',
    ' uk ',
    ', uk',
    ', uk ',
    ' uk,',
    ' uk.',
    '(uk)',
    'england',
    'scotland',
    'wales',
    'northern ireland',
    'great britain',
    ' gb ',
    ', gb',
];

/** UK cities and towns (word-boundary match to avoid e.g. "New York" matching "York") */
const UK_CITIES = [
    'aberdeen', 'aberdare', 'abingdon', 'accrington', 'aldershot', 'altrincham', 'andover', 'antrim', 'armagh',
    'ashford', 'ayr', 'banbury', 'bangor', 'barking', 'barnsley', 'barrow', 'basildon', 'basingstoke', 'bath',
    'batley', 'bedford', 'belfast', 'berwick', 'beverley', 'bexley', 'birkenhead', 'birmingham', 'blackburn',
    'blackpool', 'bolton', 'bootle', 'bournemouth', 'bracknell', 'bradford', 'brentwood', 'bridgend', 'brighton',
    'bristol', 'bromley', 'burnley', 'burton', 'bury', 'bury st edmunds', 'cambridge', 'canterbury', 'cardiff',
    'carlisle', 'carmarthen', 'chatham', 'chelmsford', 'cheltenham', 'chester', 'chesterfield', 'chichester',
    'colchester', 'coleraine', 'coventry', 'crawley', 'crewe', 'croydon', 'darlington', 'derby', 'dewsbury',
    'doncaster', 'dover', 'dudley', 'dundee', 'dunfermline', 'durham', 'eastbourne', 'eastleigh', 'edinburgh',
    'ellesmere port', 'enfield', 'exeter', 'falkirk', 'folkestone', 'gateshead', 'gillingham', 'glasgow',
    'gloucester', 'gravesend', 'great yarmouth', 'grimsby', 'guildford', 'halifax', 'harlow', 'harrogate',
    'hartlepool', 'hastings', 'hemel hempstead', 'hereford', 'high wycombe', 'huddersfield', 'hull', 'huntingdon',
    'ilford', 'ipswich', 'keighley', 'kidderminster', 'kings lynn', 'kingston upon hull', 'kingston upon thames',
    'kirkcaldy', 'knowsley', 'lancaster', 'leeds', 'leicester', 'leigh', 'lerwick', 'lewes', 'lichfield',
    'lincoln', 'liverpool', 'livingston', 'llanelli', 'london', 'loughborough', 'lowestoft', 'luton', 'macclesfield',
    'maidstone', 'manchester', 'mansfield', 'margate', 'middlesbrough', 'milton keynes', 'newbury', 'newcastle',
    'newport', 'newry', 'northampton', 'norwich', 'nottingham', 'nuneaton', 'oldham', 'omagh', 'oxford',
    'paisley', 'peterborough', 'plymouth', 'poole', 'portsmouth', 'preston', 'reading', 'redditch', 'reigate',
    'rochdale', 'rotherham', 'rugby', 'runcorn', 'salford', 'salisbury', 'scarborough', 'scunthorpe', 'sheffield',
    'shrewsbury', 'slough', 'solihull', 'southampton', 'southend', 'southport', 'st albans', 'st helens',
    'stafford', 'stevenage', 'stockport', 'stockton', 'stoke', 'stratford', 'sunderland', 'sutton', 'swansea',
    'swindon', 'tamworth', 'taunton', 'teesside', 'telford', 'tonbridge', 'torquay', 'truro', 'tunbridge wells',
    'wakefield', 'wallasey', 'walsall', 'warrington', 'warwick', 'watford', 'wigan', 'winchester', 'wolverhampton',
    'worcester', 'worthing', 'yeovil', 'york',
];

const UK_CITY_REGEX = new RegExp(`\\b(${UK_CITIES.join('|')})\\b`, 'i');

/** Check if company page indicates UK location */
async function isUKCompany(page) {
    const text = await page.evaluate(() => {
        const locationSelectors = [
            '[data-country]',
            '[data-location]',
            '[class*="location"]',
            '[class*="country"]',
            '[class*="address"]',
            '.company-info',
            'address',
            '[title*="country"]',
            '[title*="location"]',
            'div.col-6.small',
            'div.col-12.small',
        ];
        const parts = [];
        locationSelectors.forEach((sel) => {
            try {
                document.querySelectorAll(sel).forEach((el) => {
                    parts.push((el.textContent || '').toLowerCase());
                    parts.push((el.getAttribute('data-country') || '').toLowerCase());
                    parts.push((el.getAttribute('data-location') || '').toLowerCase());
                    parts.push((el.getAttribute('title') || '').toLowerCase());
                });
            } catch (_) {}
        });
        const contactDetailsH6 = Array.from(document.querySelectorAll('h6')).find((h) =>
            (h.textContent || '').trim().toLowerCase() === 'contact details'
        );
        if (contactDetailsH6) {
            const block = contactDetailsH6.closest('div[class*="_block_"], div.row') || contactDetailsH6.parentElement;
            if (block) parts.push((block.textContent || '').toLowerCase());
        }
        const mapsLink = document.querySelector('a[href*="google.com/maps"][href*=", GB"]');
        if (mapsLink) parts.push('united kingdom');
        const header = document.querySelector('header, [class*="company-header"], [class*="detail-header"]');
        if (header) parts.push((header.textContent || '').toLowerCase());
        const main = document.querySelector('main, [role="main"], .company-detail, [class*="company-detail"]');
        if (main) parts.push((main.textContent || '').toLowerCase());
        return parts.join(' ');
    });
    const lower = ` ${text} `.toLowerCase();
    if (UK_INDICATORS.some((ind) => lower.includes(ind))) return true;
    return UK_CITY_REGEX.test(text);
}

(async () => {
    let browser;
    const allStakeholders = [];
    const headers = ['Company Name', 'Company ID', 'First Name', 'Last Name', 'Title', 'Email', 'Phone'];

    try {
        console.log('Launching browser...');
        const userDataDir = path.join(os.tmpdir(), `leadinfo-scraper-${Date.now()}`);
        const prefsDir = path.join(userDataDir, 'Default');
        fs.mkdirSync(prefsDir, { recursive: true });
        fs.writeFileSync(
            path.join(prefsDir, 'Preferences'),
            JSON.stringify({
                protocol_handler: { excluded_schemes: { mailto: true, tel: true } },
            }),
            'utf8'
        );
        browser = await puppeteer.launch({
            headless: CONFIG.headless,
            defaultViewport: null,
            userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        page.setDefaultTimeout(CONFIG.timeout);

        // Close any new tabs/popups immediately
        page.on('popup', async (popup) => {
            try { await popup.close(); } catch (_) {}
        });
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page' && target !== page.target()) {
                    const p = await target.page();
                    if (p && p !== page) await p.close();
                }
            } catch (_) {}
        });

        // Block mailto:/tel: to prevent "open this application" dialogs (which close the page)
        await page.setRequestInterception(true);
        page.on('request', async (req) => {
            try {
                const url = req.url();
                if (url.startsWith('mailto:') || url.startsWith('tel:')) {
                    await req.abort();
                } else {
                    await req.continue();
                }
            } catch {
                /* request already handled or page closed */
            }
        });

        // Hide live chat launcher to prevent accidental clicks
        await page.evaluateOnNewDocument(() => {
            const hideChat = () => {
                document.querySelectorAll('[data-test-id="pill-launcher"], [aria-label="Open live chat"]').forEach((el) => {
                    el.style.display = 'none';
                    el.style.pointerEvents = 'none';
                });
            };
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', hideChat);
            } else {
                hideChat();
            }
            const obs = new MutationObserver(hideChat);
            obs.observe(document.documentElement, { childList: true, subtree: true });
        });

        // Inject capture-phase handler to prevent mailto/tel and target="_blank" links
        await page.evaluateOnNewDocument(() => {
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a) {
                    if (a.href?.startsWith('mailto:') || a.href?.startsWith('tel:')) {
                        e.preventDefault();
                        e.stopPropagation();
                    } else if (a.target === '_blank') {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
            }, true);
            document.addEventListener('mousedown', (e) => {
                const a = e.target.closest('a');
                if (a) {
                    if (a.href?.startsWith('mailto:') || a.href?.startsWith('tel:')) {
                        e.preventDefault();
                        e.stopPropagation();
                    } else if (a.target === '_blank') {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
            }, true);
        });

        // 1. Login
        console.log('Navigating to login page...');
        await page.goto(CONFIG.loginUrl, {
            waitUntil: 'networkidle2',
            timeout: CONFIG.timeout,
        });

        const emailSelector = await page.$('input[type="email"], input[name="email"], #email').catch(() => null);
        const passwordSelector = await page.$('input[type="password"], input[name="password"], #password').catch(() => null);

        if (emailSelector && passwordSelector) {
            console.log('Entering credentials...');
            await page.type('input[type="email"], input[name="email"], #email', CONFIG.credentials.email);
            await page.type('input[type="password"], input[name="password"], #password', CONFIG.credentials.password);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout }),
                page.click('button[type="submit"], .btn-primary'),
            ]);
        } else {
            console.log('Login form not found. If already logged in, continuing. Otherwise, log in manually...');
            await delay(5000);
        }

        // 2. Navigate to Inbox
        console.log('Navigating to Inbox...');
        await page.goto(CONFIG.inboxUrl, {
            waitUntil: 'networkidle2',
            timeout: CONFIG.timeout,
        });

        // Wait for inbox content to load (SPA may render after navigation)
        await page.waitForSelector('[data-company-id], a[href*="/inbox/"], .ReactVirtualized__Grid, [role="list"]', {
            timeout: 15000,
        }).catch(() => { /* continue if not found */ });
        await delay(3000);

        // Scroll to trigger lazy-loaded rows (virtualized lists)
        await page.evaluate(() => {
            const list = document.querySelector('.ReactVirtualized__Grid, [role="list"], .inbox-list, main');
            if (list) list.scrollTop = list.scrollHeight;
        }).catch(() => {});
        await delay(1500);

        // 3. Get company IDs from list (try multiple selectors - Leadinfo structure can vary)
        let companyIds = await page.$$eval('[data-company-id]', (els) =>
            [...new Set(els.map((e) => e.dataset.companyId || e.getAttribute('data-company-id')).filter(Boolean))]
        );

        if (companyIds.length === 0) {
            // Fallback: extract IDs from links like /inbox/today/5968301
            companyIds = await page.$$eval('a[href*="/inbox/"]', (links) => {
                const ids = [];
                const seen = new Set();
                for (const a of links) {
                    const m = (a.getAttribute('href') || '').match(/\/inbox\/[^/]+\/(\d+)/);
                    if (m && m[1] && !seen.has(m[1])) {
                        seen.add(m[1]);
                        ids.push(m[1]);
                    }
                }
                return ids;
            });
        }

        if (companyIds.length === 0) {
            // Fallback: look for clickable rows with company IDs in data attributes
            companyIds = await page.evaluate(() => {
                const ids = [];
                const seen = new Set();
                document.querySelectorAll('[data-company-id], [data-companyid], [data-id]').forEach((el) => {
                    const id = el.dataset.companyId || el.getAttribute('data-company-id') ||
                        el.dataset.companyid || el.getAttribute('data-companyid') ||
                        (el.getAttribute('data-id') && /^\d+$/.test(el.getAttribute('data-id')) ? el.getAttribute('data-id') : null);
                    if (id && !seen.has(id)) {
                        seen.add(id);
                        ids.push(id);
                    }
                });
                return ids;
            });
        }

        if (companyIds.length === 0) {
            console.log('No companies found in Inbox. Ensure you are logged in and the Inbox has data.');
            console.log('Tip: The inbox list may need to load. Try increasing the delay or check the page structure.');
            return;
        }

        const idsToProcess = companyIds.slice(0, CONFIG.maxCompanies);
        console.log(`Found ${companyIds.length} companies. Processing ${idsToProcess.length}...`);

        for (let i = 0; i < idsToProcess.length; i++) {
            const companyId = idsToProcess[i];
            try {
                console.log(`[${i + 1}/${idsToProcess.length}] Processing company ${companyId}...`);

                await page.goto(`${CONFIG.inboxUrl}/${companyId}`, {
                    waitUntil: 'networkidle2',
                    timeout: CONFIG.timeout,
                });

                await delay(1500);

                if (CONFIG.ukOnly) {
                    const isUK = await isUKCompany(page);
                    if (!isUK) {
                        console.log(`  Skipping company ${companyId} (not UK).`);
                        continue;
                    }
                }

                // 4. Click Contacts tab
                let contactsTab = await page.$('#company-contacts-tab-header');
                if (!contactsTab) {
                    const contactsSelector = await page.evaluate(() => {
                        const items = Array.from(document.querySelectorAll('li[id*="contacts"], [id*="contacts-tab"]'));
                        return items.length ? '#' + items[0].id : null;
                    });
                    if (contactsSelector) contactsTab = await page.$(contactsSelector);
                }
                if (!contactsTab) {
                    console.warn(`  No Contacts tab for company ${companyId}, skipping.`);
                    continue;
                }
                await contactsTab.click();
                await delay(1500);

                await page.evaluate(() => {
                    document.querySelectorAll('[data-test-id="pill-launcher"], [aria-label="Open live chat"]').forEach((el) => {
                        el.style.display = 'none';
                        el.style.pointerEvents = 'none';
                    });
                });

                // Prevent link clicks in contacts area (avoids new tabs / navigation away)
                await page.evaluate(() => {
                    const contacts = document.querySelector('#tab-company-contacts-tab');
                    if (contacts) {
                        contacts.addEventListener('click', (e) => {
                            if (e.target.closest('a') && !e.target.closest('button')) e.preventDefault();
                        }, true);
                    }
                });

                // 5. Get company name from header
                let companyName = 'Unknown';
                try {
                    companyName =
                        (await page.$eval('header h4', (el) => el?.textContent?.trim())) ||
                        (await page.$eval('h4.d-flex', (el) => el?.textContent?.trim())) ||
                        'Unknown';
                } catch {
                    /* use default */
                }

                let pageNum = 1;
                let hasMorePages = true;
                let contactsForCompany = 0;

                while (hasMorePages && contactsForCompany < CONFIG.maxContactsPerCompany) {
                    let contactBlocks = await page.$$('#tab-company-contacts-tab .col-12.px-3.py-2');
                    if (contactBlocks.length === 0) {
                        contactBlocks = await page.$$('#tab-company-contacts-tab .row.no-gutters .col-12');
                    }

                    for (let j = 0; j < contactBlocks.length; j++) {
                        const block = contactBlocks[j];
                        try {
                            const nameEl = await block.$('h6.text-dark');
                            const name = nameEl ? (await nameEl.evaluate((n) => n.textContent?.trim())) : '';
                            if (!name || !isStakeholderRow(name)) continue;

                            const titleEl = await block.$('div.text-muted, [class*="_subtitle_"]');
                            const title = titleEl ? (await titleEl.evaluate((t) => t.textContent?.trim())) : '';

                            if (!matchesTitleFilter(title, CONFIG.titleKeywords)) continue;

                            const { firstName, lastName } = parseName(name);

                            let email = '';
                            let phone = '';

                            await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
                            await delay(200);

                            await page.evaluate(() => {
                                document.querySelectorAll('.dropdown-menu.show').forEach((m) => {
                                    m.classList.remove('show');
                                    m.querySelectorAll('a[href^="tel:"], a[href^="mailto:"], a[target="_blank"]').forEach((a) => {
                                        a.removeAttribute('href');
                                        a.removeAttribute('target');
                                        a.style.pointerEvents = 'none';
                                    });
                                });
                                if (document.activeElement && document.activeElement !== document.body) {
                                    document.activeElement.blur();
                                }
                            });
                            await page.keyboard.press('Escape');
                            await delay(300);

                            await page.waitForFunction(
                                () => !document.querySelector('.dropdown-menu.show'),
                                { timeout: 2000 }
                            ).catch(() => {});

                            const emailBtn = await block.evaluateHandle((el) => {
                                const emailHints = ['email', 'mail', 'envelope'];
                                let btn = Array.from(el.querySelectorAll('button.btn-link.options, button[class*="options"], button')).find((b) => {
                                    const img = b.querySelector('img');
                                    const src = (img?.getAttribute('src') || img?.getAttribute('alt') || '').toLowerCase();
                                    return emailHints.some((h) => src.includes(h));
                                });
                                if (!btn) {
                                    const img = el.querySelector('img[src*="email"], img[src*="mail"], img[alt*="email"]');
                                    if (img) btn = img.closest('button, [role="button"], a');
                                }
                                return btn;
                            });
                            try {
                                const emailBtnEl = emailBtn.asElement();
                                if (emailBtnEl) {
                                    await emailBtnEl.click();
                                    await page.waitForSelector('.dropdown-menu.show', { timeout: 2000 }).catch(() => {});
                                    await delay(400);
                                    const emailText = await page.evaluate(() => {
                                        const menu = document.querySelector('.dropdown-menu.show');
                                        if (!menu) return '';
                                        let email = '';
                                        const sel = 'span.text-truncate, [class*="truncate"]';
                                        for (const el of menu.querySelectorAll(sel)) {
                                            const t = (el.textContent || '').trim();
                                            if (t && t.includes('@') && !/^get\s|^add\s|^request\s/i.test(t)) {
                                                email = t;
                                                break;
                                            }
                                        }
                                        if (!email) {
                                            const mailto = menu.querySelector('a[href^="mailto:"]');
                                            if (mailto) {
                                                const h = (mailto.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
                                                if (h && h.includes('@')) email = h;
                                            }
                                        }
                                        menu.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]').forEach((a) => {
                                            a.removeAttribute('href');
                                            a.style.pointerEvents = 'none';
                                        });
                                        return email;
                                    });
                                    if (emailText) email = emailText;
                                    await page.keyboard.press('Escape');
                                    await delay(500);
                                }
                            } finally {
                                emailBtn.dispose();
                            }

                            await delay(200);

                            const phoneBtn = await block.evaluateHandle((el) => {
                                const phoneHints = ['phone', 'call', 'tel'];
                                let btn = Array.from(el.querySelectorAll('button.btn-link.options, button[class*="options"], button')).find((b) => {
                                    const img = b.querySelector('img');
                                    const src = (img?.getAttribute('src') || img?.getAttribute('alt') || '').toLowerCase();
                                    return phoneHints.some((h) => src.includes(h));
                                });
                                if (!btn) {
                                    const img = el.querySelector('img[src*="phone"], img[src*="call"], img[alt*="phone"]');
                                    if (img) btn = img.closest('button, [role="button"], a');
                                }
                                return btn;
                            });
                            try {
                                const phoneBtnEl = phoneBtn.asElement();
                                if (phoneBtnEl) {
                                    await phoneBtnEl.click();
                                    await page.waitForSelector('.dropdown-menu.show', { timeout: 2000 }).catch(() => {});
                                    await delay(400);
                                    const phoneText = await page.evaluate(() => {
                                        const menu = document.querySelector('.dropdown-menu.show');
                                        if (!menu) return '';
                                        let phone = '';
                                        const sel = 'span.text-truncate, [class*="truncate"]';
                                        for (const el of menu.querySelectorAll(sel)) {
                                            const t = (el.textContent || '').trim();
                                            if (t && /^\+?[\d\s\-().]+$/.test(t.replace(/\s/g, ''))) {
                                                phone = t;
                                                break;
                                            }
                                        }
                                        if (!phone) {
                                            const tel = menu.querySelector('a[href^="tel:"]');
                                            if (tel) {
                                                const h = (tel.getAttribute('href') || '').replace(/^tel:/i, '').trim();
                                                if (h && /^\+?[\d\s\-().]+$/.test(h.replace(/\s/g, ''))) phone = h;
                                            }
                                        }
                                        menu.querySelectorAll('a[href^="tel:"]').forEach((a) => {
                                            a.removeAttribute('href');
                                            a.style.pointerEvents = 'none';
                                        });
                                        menu.querySelectorAll('a[target="_blank"]').forEach((a) => {
                                            a.removeAttribute('target');
                                            a.style.pointerEvents = 'none';
                                        });
                                        return phone;
                                    });
                                    if (phoneText) phone = phoneText;
                                    await page.keyboard.press('Escape');
                                    await delay(500);
                                }
                            } finally {
                                phoneBtn.dispose();
                            }

                            await delay(CONFIG.delayBetweenContacts);

                            allStakeholders.push({
                                companyName,
                                companyId,
                                firstName,
                                lastName,
                                title,
                                email,
                                phone,
                            });
                            contactsForCompany++;
                            if (contactsForCompany >= CONFIG.maxContactsPerCompany) break;
                        } catch (err) {
                            console.warn(`  Error extracting contact: ${err.message}`);
                        }
                    }

                    if (contactsForCompany >= CONFIG.maxContactsPerCompany) {
                        hasMorePages = false;
                        break;
                    }

                    const clickedNext = await page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        const nextBtn = btns.find((b) => b.textContent?.trim() === 'Next' && !b.disabled);
                        if (nextBtn) {
                            nextBtn.click();
                            return true;
                        }
                        return false;
                    });

                    if (clickedNext) {
                        await delay(1500);
                        pageNum++;
                    } else {
                        hasMorePages = false;
                    }
                }

                console.log(`  Extracted ${allStakeholders.filter((s) => s.companyId === companyId).length} contacts.`);
            } catch (err) {
                console.warn(`  Error processing company ${companyId}: ${err.message}`);
            }

            if (i < idsToProcess.length - 1) {
                await delay(CONFIG.delayBetweenCompanies);
            }
        }

        // 6. Write CSV
        console.log(`\nTotal stakeholders: ${allStakeholders.length}. Writing CSV...`);

        const csvRows = [
            headers.join(','),
            ...allStakeholders.map((row) =>
                [
                    row.companyName,
                    row.companyId,
                    row.firstName,
                    row.lastName,
                    row.title,
                    row.email,
                    row.phone,
                ].map(escapeCsvField).join(',')
            ),
        ];
        const csvContent = csvRows.join('\n');
        fs.writeFileSync(CONFIG.outputFile, csvContent, 'utf8');
        console.log(`Success! Data saved to ${CONFIG.outputFile}`);
    } catch (error) {
        console.error('Scraping failed:', error.message);
        process.exitCode = 1;
    } finally {
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
    }
})();
