const fs = require('fs/promises');
const path = require('path');

// --- Configuration ---
const FILE_PATHS = {
    remainingWords: path.join(__dirname, 'remaining-words.txt'),
    masterVocab: path.join(__dirname, 'shared', 'data', 'master-vocab.json'),
    failedWords: path.join(__dirname, 'failed-words.txt')
};

const CONFIG = {
    batchSize: 50,
    delayBetweenCallsMs: 2000,
    // Strict chronological fallback order prioritizing the oldest edition
    websterEditions: [1828, 1847, 1864, 1890, 1913] 
};

// --- Helper Functions ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Replace this internal logic with your specific API endpoint or local dataset query.
 * It simulates fetching from a specific dictionary edition.
 */
async function queryDictionaryArchive(word, year) {
    try {
        // Example structure for where the fetch logic goes:
        // const response = await fetch(`https://api.example.com/websters/${year}/${word}`);
        // if (!response.ok) return null;
        // const data = await response.json();
        // return data; 
        
        return null; // Returning null by default to trigger the fallback loop until endpoints are connected
    } catch (error) {
        return null;
    }
}

/**
 * Attempts to find a word, cascading through historical editions.
 */
async function fetchDefinitionWithFallback(word) {
    for (const year of CONFIG.websterEditions) {
        const result = await queryDictionaryArchive(word, year);
        
        if (result && result.definition) {
            return {
                word: word,
                definition: result.definition,
                part_of_speech: result.partOfSpeech || '',
                source_edition: year
            };
        }
    }
    return null; // Word not found in any historical archive
}

// --- Main Execution ---
async function runIngester() {
    console.log('Starting Vocabulary Ingestion Process...\n');

    try {
        // 1. Read existing database and establish schema
        const dbContent = await fs.readFile(FILE_PATHS.masterVocab, 'utf-8');
        const dbArray = JSON.parse(dbContent);
        
        if (!Array.isArray(dbArray) || dbArray.length === 0) {
            throw new Error("master-vocab.json is empty or invalid. Cannot infer schema.");
        }

        const templateSchema = Object.keys(dbArray[0]);
        console.log(`Schema inferred from starter words: [${templateSchema.join(', ')}]\n`);

        // 2. Read remaining words
        const wordsContent = await fs.readFile(FILE_PATHS.remainingWords, 'utf-8');
        const wordsToProcess = wordsContent.split('\n').map(w => w.trim()).filter(w => w.length > 0);
        const totalWords = wordsToProcess.length;
        
        console.log(`Loaded ${totalWords} words to process.\n`);

        const failedWords = [];
        let processedCount = 0;

        // 3. Process in batches
        for (let i = 0; i < totalWords; i += CONFIG.batchSize) {
            const batch = wordsToProcess.slice(i, i + CONFIG.batchSize);
            
            for (const word of batch) {
                processedCount++;
                
                // Enforce rate limit delay
                if (processedCount > 1) {
                    await delay(CONFIG.delayBetweenCallsMs);
                }

                const dictionaryData = await fetchDefinitionWithFallback(word);

                if (dictionaryData) {
                    // Map to schema, ensuring all keys exist, even if empty
                    const newEntry = {};
                    for (const key of templateSchema) {
                        newEntry[key] = dictionaryData[key] !== undefined ? dictionaryData[key] : "";
                    }
                    // Ensure the tracking key is appended if the starter schema lacked it
                    newEntry["source_edition"] = dictionaryData.source_edition;

                    dbArray.push(newEntry);
                    console.log(`Processing ${processedCount}/${totalWords}: "${word}" - Success (${dictionaryData.source_edition})`);
                } else {
                    failedWords.push(word);
                    console.log(`Processing ${processedCount}/${totalWords}: "${word}" - FAILED (Not found in any edition)`);
                }
            }

            // Save progress after every batch
            await fs.writeFile(FILE_PATHS.masterVocab, JSON.stringify(dbArray, null, 2), 'utf-8');
        }

        // 4. Log failures
        if (failedWords.length > 0) {
            await fs.writeFile(FILE_PATHS.failedWords, failedWords.join('\n'), 'utf-8');
            console.log(`\nIngestion complete. ${failedWords.length} words failed. Logged to failed-words.txt.`);
        } else {
            console.log('\nIngestion complete. All words processed successfully.');
        }

    } catch (error) {
        console.error('CRITICAL ERROR during ingestion:', error.message);
    }
}

// Execute
runIngester();