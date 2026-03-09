/**
 * Leadinfo Stakeholder API
 *
 * HTTP API endpoint for n8n workflows. Accepts POST requests with a company name,
 * scrapes lead/stakeholder data for that company from Leadinfo, and returns JSON.
 *
 * Deploy on DigitalOcean App Platform from GitHub.
 * Configure credentials via environment variables (LEADINFO_EMAIL, LEADINFO_PASSWORD).
 */

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');
const fs = require('fs');

// --- Configuration ---
const CONFIG = {
    loginUrl: 'https://portal.leadinfo.com/login',
    credentials: {
        email: process.env.LEADINFO_EMAIL || '',
        password: process.env.LEADINFO_PASSWORD || '',
    },
    selectors: {
        email: 'input[name="email"], input[type="email"], #email',
        password: 'input[name="password"], input[type="password"], #password',
        signIn: 'button[type="submit"], [data-testid="sign-in"], .btn-primary',
    },
    inboxUrl: 'https://portal.leadinfo.com/inbox/today',
    maxContactsPerCompany: 20,
    ukOnly: process.env.LEADINFO_UK_ONLY !== 'false',
    titleKeywords: [
        'ceo', 'cto', 'cfo', 'coo', 'chief', 'owner', 'founder', 'partner',
        'director', 'managing director', 'head of', 'vp', 'vice president',
        'manager', 'head', 'lead',
    ],
    headless: process.env.NODE_ENV === 'production' ? 'new' : false,
    timeout: 60000,
    delayBetweenCompanies: 800,
    delayBetweenContacts: 250,
};

/** Normalize company name for comparison (trim, lowercase) */
function normalizeCompanyName(name) {
    return String(name ?? '').trim().toLowerCase();
}

/** Check if two company names match (exact, case-insensitive) */
function companyNameMatches(requested, actual) {
    const a = normalizeCompanyName(requested);
    const b = normalizeCompanyName(actual);
    return a.length > 0 && a === b;
}

/** Check if title matches any of the configured keywords */
function matchesTitleFilter(title, keywords) {
    if (!keywords || keywords.length === 0) return true;
    const t = String(title || '').toLowerCase();
    return keywords.some((kw) => t.includes(kw.toLowerCase()));
}

/** Check if a row is a stakeholder (person contact) */
function isStakeholderRow(name) {
    const n = String(name || '').trim();
    if (!n || n.length < 2) return false;
    const skip = /^(get|add|request|company|view|show|more|loading|\.\.\.)$/i;
    if (skip.test(n)) return false;
    return true;
}

/** Parse full name into first and last */
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

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const UK_INDICATORS = [
    'united kingdom', ' united kingdom', '\u00a0united kingdom', ' uk ', ', uk', ', uk ', ' uk,', ' uk.', '(uk)',
    'england', 'scotland', 'wales', 'northern ireland', 'great britain', ' gb ', ', gb',
];
const UK_CITIES = [
    'aberdeen', 'belfast', 'birmingham', 'bristol', 'cambridge', 'cardiff', 'edinburgh', 'glasgow',
    'leeds', 'liverpool', 'london', 'manchester', 'newcastle', 'nottingham', 'oxford', 'sheffield',
];
const UK_CITY_REGEX = new RegExp(`\\b(${UK_CITIES.join('|')})\\b`, 'i');

async function isUKCompany(page) {
    const text = await page.evaluate(() => {
        const parts = [];
        document.querySelectorAll('[data-country], [data-location], [class*="location"], [class*="country"], address').forEach((el) => {
            parts.push((el.textContent || '').toLowerCase());
        });
        const main = document.querySelector('main, [role="main"], .company-detail');
        if (main) parts.push((main.textContent || '').toLowerCase());
        return parts.join(' ');
    });
    const lower = ` ${text} `.toLowerCase();
    if (UK_INDICATORS.some((ind) => lower.includes(ind))) return true;
    return UK_CITY_REGEX.test(text);
}

/**
 * Scrape stakeholder data for a specific company by name.
 * @param {string} targetCompanyName - Exact company name to find (case-insensitive)
 * @returns {Promise<{companyName: string, companyId: string, stakeholders: Array}>}
 */
async function scrapeCompanyStakeholders(targetCompanyName) {
    const userDataDir = path.join(os.tmpdir(), `leadinfo-api-${Date.now()}`);
    const prefsDir = path.join(userDataDir, 'Default');
    fs.mkdirSync(prefsDir, { recursive: true });
    fs.writeFileSync(
        path.join(prefsDir, 'Preferences'),
        JSON.stringify({ protocol_handler: { excluded_schemes: { mailto: true, tel: true } } }),
        'utf8'
    );

    const browser = await puppeteer.launch({
        headless: CONFIG.headless,
        defaultViewport: null,
        userDataDir,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(CONFIG.timeout);

        page.on('popup', async (popup) => { try { await popup.close(); } catch (_) {} });
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page' && target !== page.target()) {
                    const p = await target.page();
                    if (p && p !== page) await p.close();
                }
            } catch (_) {}
        });

        await page.setRequestInterception(true);
        page.on('request', async (req) => {
            try {
                const url = req.url();
                if (url.startsWith('mailto:') || url.startsWith('tel:')) await req.abort();
                else await req.continue();
            } catch (_) {}
        });

        await page.evaluateOnNewDocument(() => {
            const hideChat = () => {
                document.querySelectorAll('[data-test-id="pill-launcher"], [aria-label="Open live chat"]').forEach((el) => {
                    el.style.display = 'none';
                    el.style.pointerEvents = 'none';
                });
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideChat);
            else hideChat();
            const obs = new MutationObserver(hideChat);
            obs.observe(document.documentElement, { childList: true, subtree: true });
        });

        await page.evaluateOnNewDocument(() => {
            document.addEventListener('click', (e) => {
                const a = e.target.closest('a');
                if (a && (a.href?.startsWith('mailto:') || a.href?.startsWith('tel:') || a.target === '_blank')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        });

        // 1. Login
        await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

        const emailSelector = await page.$('input[type="email"], input[name="email"], #email').catch(() => null);
        const passwordSelector = await page.$('input[type="password"], input[name="password"], #password').catch(() => null);

        if (emailSelector && passwordSelector) {
            await page.type('input[type="email"], input[name="email"], #email', CONFIG.credentials.email);
            await page.type('input[type="password"], input[name="password"], #password', CONFIG.credentials.password);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout }),
                page.click('button[type="submit"], .btn-primary'),
            ]);
        } else {
            await delay(5000);
        }

        // 2. Navigate to Inbox
        await page.goto(CONFIG.inboxUrl, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
        await page.waitForSelector('[data-company-id], a[href*="/inbox/"], .ReactVirtualized__Grid, [role="list"]', { timeout: 15000 }).catch(() => {});
        await delay(3000);

        await page.evaluate(() => {
            const list = document.querySelector('.ReactVirtualized__Grid, [role="list"], .inbox-list, main');
            if (list) list.scrollTop = list.scrollHeight;
        }).catch(() => {});
        await delay(1500);

        // 3. Get company IDs
        let companyIds = await page.$$eval('[data-company-id]', (els) =>
            [...new Set(els.map((e) => e.dataset.companyId || e.getAttribute('data-company-id')).filter(Boolean))]
        );
        if (companyIds.length === 0) {
            companyIds = await page.$$eval('a[href*="/inbox/"]', (links) => {
                const ids = [];
                const seen = new Set();
                for (const a of links) {
                    const m = (a.getAttribute('href') || '').match(/\/inbox\/[^/]+\/(\d+)/);
                    if (m && m[1] && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
                }
                return ids;
            });
        }
        if (companyIds.length === 0) {
            companyIds = await page.evaluate(() => {
                const ids = [];
                const seen = new Set();
                document.querySelectorAll('[data-company-id], [data-companyid], [data-id]').forEach((el) => {
                    const id = el.dataset.companyId || el.getAttribute('data-company-id') ||
                        el.dataset.companyid || el.getAttribute('data-companyid') ||
                        (el.getAttribute('data-id') && /^\d+$/.test(el.getAttribute('data-id')) ? el.getAttribute('data-id') : null);
                    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
                });
                return ids;
            });
        }

        if (companyIds.length === 0) {
            throw new Error('No companies found in Inbox. Ensure you are logged in and the Inbox has data.');
        }

        const targetNorm = normalizeCompanyName(targetCompanyName);

        for (const companyId of companyIds) {
            try {
                await page.goto(`${CONFIG.inboxUrl}/${companyId}`, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
                await delay(1500);

                if (CONFIG.ukOnly) {
                    const isUK = await isUKCompany(page);
                    if (!isUK) continue;
                }

                let companyName = 'Unknown';
                try {
                    companyName =
                        (await page.$eval('header h4', (el) => el?.textContent?.trim())) ||
                        (await page.$eval('h4.d-flex', (el) => el?.textContent?.trim())) ||
                        'Unknown';
                } catch (_) {}

                if (!companyNameMatches(targetCompanyName, companyName)) continue;

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
                    return { companyName, companyId, stakeholders: [] };
                }
                await contactsTab.click();
                await delay(1500);

                await page.evaluate(() => {
                    document.querySelectorAll('[data-test-id="pill-launcher"], [aria-label="Open live chat"]').forEach((el) => {
                        el.style.display = 'none';
                        el.style.pointerEvents = 'none';
                    });
                });

                await page.evaluate(() => {
                    const contacts = document.querySelector('#tab-company-contacts-tab');
                    if (contacts) {
                        contacts.addEventListener('click', (e) => {
                            if (e.target.closest('a') && !e.target.closest('button')) e.preventDefault();
                        }, true);
                    }
                });

                const stakeholders = [];
                let pageNum = 1;
                let hasMorePages = true;
                let contactsForCompany = 0;

                while (hasMorePages && contactsForCompany < CONFIG.maxContactsPerCompany) {
                    let contactBlocks = await page.$$('#tab-company-contacts-tab .col-12.px-3.py-2');
                    if (contactBlocks.length === 0) {
                        contactBlocks = await page.$$('#tab-company-contacts-tab .row.no-gutters .col-12');
                    }

                    for (const block of contactBlocks) {
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
                                document.querySelectorAll('.dropdown-menu.show').forEach((m) => m.classList.remove('show'));
                                if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
                            });
                            await page.keyboard.press('Escape');
                            await delay(300);

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
                                        for (const el of menu.querySelectorAll('span.text-truncate, [class*="truncate"]')) {
                                            const t = (el.textContent || '').trim();
                                            if (t && t.includes('@') && !/^get\s|^add\s|^request\s/i.test(t)) { email = t; break; }
                                        }
                                        if (!email) {
                                            const mailto = menu.querySelector('a[href^="mailto:"]');
                                            if (mailto) {
                                                const h = (mailto.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
                                                if (h && h.includes('@')) email = h;
                                            }
                                        }
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
                                        for (const el of menu.querySelectorAll('span.text-truncate, [class*="truncate"]')) {
                                            const t = (el.textContent || '').trim();
                                            if (t && /^\+?[\d\s\-().]+$/.test(t.replace(/\s/g, ''))) { phone = t; break; }
                                        }
                                        if (!phone) {
                                            const tel = menu.querySelector('a[href^="tel:"]');
                                            if (tel) {
                                                const h = (tel.getAttribute('href') || '').replace(/^tel:/i, '').trim();
                                                if (h && /^\+?[\d\s\-().]+$/.test(h.replace(/\s/g, ''))) phone = h;
                                            }
                                        }
                                        return phone;
                                    });
                                    if (phoneText) phone = phoneText;
                                    await page.keyboard.press('Escape');
                                    await delay(500);
                                }
                            } finally {
                                phoneBtn.dispose();
                            }

                            stakeholders.push({ firstName, lastName, title, email, phone });
                            contactsForCompany++;
                            if (contactsForCompany >= CONFIG.maxContactsPerCompany) break;
                        } catch (_) {}
                    }

                    if (contactsForCompany >= CONFIG.maxContactsPerCompany) break;

                    const clickedNext = await page.evaluate(() => {
                        const nextBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Next' && !b.disabled);
                        if (nextBtn) { nextBtn.click(); return true; }
                        return false;
                    });
                    if (clickedNext) {
                        await delay(1500);
                        pageNum++;
                    } else {
                        hasMorePages = false;
                    }
                }

                return { companyName, companyId, stakeholders };
            } catch (err) {
                // Continue to next company
            }
        }

        return null; // Company not found
    } finally {
        await browser.close();
    }
}

// --- Express API ---
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'leadinfo-api' });
});

app.post('/scrape', async (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== 'object') {
            return res.status(400).json({
                success: false,
                error: 'Invalid request body',
                code: 'INVALID_BODY',
            });
        }

        const companyName = body.companyName ?? body.company_name ?? body.company;

        if (!companyName || typeof companyName !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid companyName. Expected: { "companyName": "Your Company Ltd" }',
                code: 'MISSING_COMPANY_NAME',
            });
        }

        const trimmed = String(companyName).trim();
        if (trimmed.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'companyName cannot be empty',
                code: 'EMPTY_COMPANY_NAME',
            });
        }

        if (!CONFIG.credentials.email || !CONFIG.credentials.password) {
            return res.status(503).json({
                success: false,
                error: 'Service misconfigured: LEADINFO_EMAIL and LEADINFO_PASSWORD must be set',
                code: 'CONFIG_ERROR',
            });
        }

        const result = await scrapeCompanyStakeholders(trimmed);

        if (result === null) {
            return res.status(404).json({
                success: false,
                error: `Company not found: "${trimmed}"`,
                code: 'COMPANY_NOT_FOUND',
                requestedCompanyName: trimmed,
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                companyName: result.companyName,
                companyId: result.companyId,
                stakeholders: result.stakeholders,
                stakeholderCount: result.stakeholders.length,
            },
        });
    } catch (error) {
        console.error('Scrape error:', error);

        const message = error.message || 'Internal server error';
        const isAuth = /login|auth|credential|unauthorized/i.test(message);
        const isTimeout = /timeout|timed out/i.test(message);

        if (isAuth) {
            return res.status(401).json({
                success: false,
                error: 'Authentication failed. Check credentials.',
                code: 'AUTH_ERROR',
            });
        }
        if (isTimeout) {
            return res.status(504).json({
                success: false,
                error: 'Request timed out',
                code: 'TIMEOUT',
            });
        }

        return res.status(500).json({
            success: false,
            error: 'Scraping failed',
            code: 'SCRAPE_ERROR',
            message: process.env.NODE_ENV === 'development' ? message : undefined,
        });
    }
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
        code: 'NOT_FOUND',
        hint: 'POST /scrape with { "companyName": "Your Company Ltd" }',
    });
});

app.listen(PORT, () => {
    console.log(`Leadinfo API listening on port ${PORT}`);
});
