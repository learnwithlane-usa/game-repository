const fs = require('fs/promises');
const path = require('path');

// --- Configuration ---
const FILE_PATHS = {
    remainingWords: path.join(__dirname, 'remaining-words.txt'),
    masterVocab:    path.join(__dirname, 'data', 'master-vocab.json'),
    failedWords:    path.join(__dirname, 'failed-words.txt'),
    dictionary:     path.join(__dirname, 'dictionary.txt')
};

const CONFIG = {
    batchSize: 50,
    delayBetweenCallsMs: 0,   // restore to 2000 when live remote API is wired in
    websterEditions: [1828, 1847, 1864, 1890, 1913]
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Dictionary Parser ---

// Populated once at startup; shared by queryDictionaryArchive()
let dictionaryMap = null;

/**
 * Returns true for lines that are standalone ALL-CAPS headword lines,
 * e.g. "HOME", "AARD-VARK", "AARONIC; AARONICAL", "A 1"
 */
function isHeadwordLine(line) {
    const t = line.trim();
    return (
        t.length > 0 &&
        t.length <= 60 &&
        /^[A-Z][A-Z0-9 '\-;,.!]+$/.test(t)
    );
}

/**
 * Given the raw joined text of a dictionary entry, extract the first
 * meaningful definition, handling both "Defn:" and "1." formats.
 */
function extractDefinition(raw) {
    // Normalise whitespace
    const text = raw.replace(/\s+/g, ' ').trim();

    // Strategy 1 — "Defn:" marker
    const defnIdx = text.indexOf('Defn:');
    if (defnIdx >= 0) {
        let d = text.slice(defnIdx + 5).trim();
        // Stop at next structural marker
        d = d.replace(/\s+(?:Note:|Syn\.|-- [A-Z]|\d+\. )[\s\S]*/, '').trim();
        if (d.length > 10 && !/^See\s/i.test(d)) return trimTo(d, 400);
    }

    // Strategy 2 — first numbered definition "1. ..."
    const numMatch = text.match(/(?:^|\s)1\.\s+(.+?)(?=\s+2\.\s+|\s+Note:|\s+Syn\.|\s*$)/s);
    if (numMatch) {
        const d = numMatch[1].replace(/\s+/g, ' ').trim();
        if (d.length > 10 && !/^See\s/i.test(d)) return trimTo(d, 400);
    }

    return '';
}

function trimTo(s, maxLen) {
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen).replace(/\s+\S+$/, '') + '...';
}

/**
 * Extract part-of-speech label from the first 300 characters of an entry.
 */
function extractPartOfSpeech(text) {
    const head = text.slice(0, 300);
    const checks = [
        [/\bpron\.\b/,               'pronoun'],
        [/\bconj\.\b/,               'conjunction'],
        [/\bprep\.\b/,               'preposition'],
        [/\binterj\.\b/,             'interjection'],
        [/\badv\.\b/,                'adverb'],
        [/\bv\.\s*[ti]\.\b|\bv\.\b/, 'verb'],
        [/\ba\.\b/,                  'adjective'],
        [/\bn\.\b/,                  'noun'],
    ];
    for (const [re, pos] of checks) {
        if (re.test(head)) return pos;
    }
    return '';
}

/**
 * Read dictionary.txt and build a lowercase-word → {definition, partOfSpeech} map.
 */
async function loadDictionary() {
    console.log('Loading dictionary into memory...');
    const map = new Map();

    const content = await fs.readFile(FILE_PATHS.dictionary, 'utf-8');
    const lines   = content.split('\n');

    let inBook         = false;
    let currentHead    = null;
    let entryBuf       = [];

    function flushEntry() {
        if (!currentHead || !entryBuf.length) return;

        const raw        = entryBuf.join(' ');
        const definition = extractDefinition(raw);
        if (!definition) { entryBuf = []; return; }

        const partOfSpeech = extractPartOfSpeech(raw);

        // Some headword lines contain multiple variants: "AARONIC; AARONICAL"
        const variants = currentHead.split(/[;]/).map(h => h.trim().toLowerCase());
        for (const v of variants) {
            if (v && !map.has(v)) {
                map.set(v, { definition, partOfSpeech });
            }
        }
        entryBuf = [];
    }

    for (const line of lines) {
        if (!inBook) {
            if (line.includes('*** START OF THE PROJECT GUTENBERG')) inBook = true;
            continue;
        }
        if (line.includes('*** END OF THE PROJECT GUTENBERG')) break;

        if (isHeadwordLine(line)) {
            flushEntry();
            currentHead = line.trim();
        } else {
            entryBuf.push(line);
        }
    }
    flushEntry();

    console.log(`Dictionary loaded: ${map.size.toLocaleString()} entries.\n`);
    return map;
}

// --- API Shim ---

/**
 * Looks up a word in the local dictionary archive.
 * The year parameter preserves the original fallback contract
 * (the same source file is consulted regardless of edition year).
 */
async function queryDictionaryArchive(word, year) {  // eslint-disable-line no-unused-vars
    if (!dictionaryMap) return null;
    const entry = dictionaryMap.get(word.toLowerCase());
    return entry ? { definition: entry.definition, partOfSpeech: entry.partOfSpeech } : null;
}

/**
 * Attempts to find a word, cascading through historical editions.
 */
async function fetchDefinitionWithFallback(word) {
    for (const year of CONFIG.websterEditions) {
        const result = await queryDictionaryArchive(word, year);
        if (result && result.definition) {
            return {
                word,
                definition:     result.definition,
                part_of_speech: result.partOfSpeech || '',
                source_edition: year
            };
        }
    }
    return null;
}

// --- Main Execution ---

async function runIngester() {
    console.log('Starting Vocabulary Ingestion Process...\n');

    try {
        // 1. Load dictionary into memory
        dictionaryMap = await loadDictionary();

        // 2. Read existing database and establish schema
        const dbContent = await fs.readFile(FILE_PATHS.masterVocab, 'utf-8');
        const db = JSON.parse(dbContent);

        if (!db.words || !Array.isArray(db.words) || db.words.length === 0) {
            throw new Error('master-vocab.json is empty or invalid. Cannot infer schema.');
        }

        const templateSchema = Object.keys(db.words[0]);
        console.log(`Schema: [${templateSchema.join(', ')}]\n`);

        // 3. Read remaining words
        const wordsContent  = await fs.readFile(FILE_PATHS.remainingWords, 'utf-8');
        const wordsToProcess = wordsContent.split('\n').map(w => w.trim()).filter(Boolean);
        const totalWords     = wordsToProcess.length;
        console.log(`Loaded ${totalWords.toLocaleString()} words to process.\n`);

        // 4. Build duplicate-guard set and determine next ID number
        const existingWords = new Set(db.words.map(e => e.word));
        let nextIdNum = db.words.reduce((max, e) => {
            const m = String(e.id || '').match(/(\d+)$/);
            return m ? Math.max(max, parseInt(m[1], 10)) : max;
        }, 0) + 1;

        const failedWords = [];
        let processedCount = 0;

        // 5. Process in batches
        for (let i = 0; i < totalWords; i += CONFIG.batchSize) {
            const batch = wordsToProcess.slice(i, i + CONFIG.batchSize);

            for (const word of batch) {
                processedCount++;

                if (existingWords.has(word)) {
                    console.log(`${processedCount}/${totalWords}: "${word}" - SKIPPED (already exists)`);
                    continue;
                }

                if (CONFIG.delayBetweenCallsMs > 0) await delay(CONFIG.delayBetweenCallsMs);

                const data = await fetchDefinitionWithFallback(word);

                if (data) {
                    const newEntry = {};
                    for (const key of templateSchema) {
                        if (key === 'id') {
                            newEntry.id = `hf-${String(nextIdNum++).padStart(4, '0')}`;
                        } else if (key === 'synonyms' || key === 'standards_tags') {
                            newEntry[key] = [];
                        } else if (key === 'source_type') {
                            newEntry[key] = 'webster_unabridged';
                        } else {
                            newEntry[key] = data[key] !== undefined ? data[key] : '';
                        }
                    }
                    newEntry.source_edition = data.source_edition;

                    db.words.push(newEntry);
                    existingWords.add(word);
                    console.log(`${processedCount}/${totalWords}: "${word}" - SUCCESS (${data.source_edition})`);
                } else {
                    failedWords.push(word);
                    console.log(`${processedCount}/${totalWords}: "${word}" - FAILED`);
                }
            }

            // Save progress after every batch
            db.metadata.last_updated = new Date().toISOString().split('T')[0];
            await fs.writeFile(FILE_PATHS.masterVocab, JSON.stringify(db, null, 2), 'utf-8');
        }

        // 6. Write failure log
        if (failedWords.length > 0) {
            await fs.writeFile(FILE_PATHS.failedWords, failedWords.join('\n'), 'utf-8');
            console.log(`\nIngestion complete. ${failedWords.length.toLocaleString()} words failed. Logged to failed-words.txt.`);
        } else {
            console.log('\nIngestion complete. All words processed successfully.');
        }

    } catch (error) {
        console.error('CRITICAL ERROR:', error.message);
    }
}

// Execute
runIngester();
