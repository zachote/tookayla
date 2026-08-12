// api/save-gist.js
// Endpoint serverless (Vercel) – dopisuje NOWE pozycje do ostatniego "chunku" w Gist,
// bez pobierania i wysyłania całej dotychczasowej historii przy każdym zapisie.
//
// Wymagane zmienne środowiskowe w ustawieniach projektu na Vercelu:
//   GITHUB_TOKEN  – Personal Access Token ze scope "gist" (Settings -> Environment Variables)
//   GIST_ID       – ID gista, z adresu gist.github.com/TWOJ_LOGIN/TU_JEST_ID
//   GIST_OWNER    – Twój login na GitHubie (właściciel gista)

const CHUNK_LIMIT = 900 * 1024; // bezpieczny margines poniżej limitu ~1MB/plik w Gist API

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const TOKEN = process.env.GITHUB_TOKEN;
    const GIST_ID = process.env.GIST_ID;
    const GIST_OWNER = process.env.GIST_OWNER;

    if (!TOKEN || !GIST_ID || !GIST_OWNER) {
        res.status(500).json({ error: 'Brak GITHUB_TOKEN / GIST_ID / GIST_OWNER w zmiennych środowiskowych Vercela.' });
        return;
    }

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = null; }
    }
    const newItems = body && Array.isArray(body.items) ? body.items : null;
    let lastChunkName = body && body.lastChunkName;

    if (!newItems) {
        res.status(400).json({ error: 'Oczekiwano JSON { items: [...], lastChunkName: "..." }' });
        return;
    }
    if (newItems.length === 0) {
        res.status(200).json({ ok: true, message: 'Brak nowych pozycji do zapisania.', lastChunkName });
        return;
    }

    const apiHeaders = {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'toolost-scraper-save'
    };

    // 1. Wczytaj TYLKO zawartość ostatniego chunku (nie całą historię) przez stały link "raw/<plik>".
    let workingItems = [];
    let chunkIndex = 0;
    let readOk = false;

    if (lastChunkName) {
        chunkIndex = parseInt((lastChunkName.match(/\d+/) || ['0'])[0], 10);
        try {
            const rawResp = await fetch(`https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw/${lastChunkName}`);
            if (rawResp.ok) {
                workingItems = JSON.parse(await rawResp.text());
                readOk = true;
            }
        } catch (e) {
            // spróbujemy fallbacku poniżej
        }
    }

    // Fallback: brak nazwy chunku albo odczyt się nie powiódł -> pobierz metadane całego gista
    if (!readOk) {
        const gistResp = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: apiHeaders });
        if (!gistResp.ok) {
            res.status(502).json({ error: 'Nie udało się pobrać gista.', status: gistResp.status });
            return;
        }
        const gist = await gistResp.json();
        const chunkNames = Object.keys(gist.files).filter(n => /^chunk_\d+\.json$/.test(n)).sort();
        if (chunkNames.length > 0) {
            lastChunkName = chunkNames[chunkNames.length - 1];
            chunkIndex = parseInt(lastChunkName.match(/\d+/)[0], 10);
            const file = gist.files[lastChunkName];
            let content = file.content;
            if (file.truncated) {
                const rawResp2 = await fetch(file.raw_url);
                content = await rawResp2.text();
            }
            try { workingItems = JSON.parse(content); } catch { workingItems = []; }
        } else {
            lastChunkName = 'chunk_0000.json';
            chunkIndex = 0;
            workingItems = [];
        }
    }

    // 2. Dedupe względem ostatniego chunku (dodatkowa siatka bezpieczeństwa - klient też dedupe'uje)
    const existingIds = new Set(workingItems.map(it => it.currentId));
    const seenInBatch = new Set();
    const toAdd = [];
    for (const item of newItems) {
        if (!item || typeof item.currentId === 'undefined') continue;
        if (existingIds.has(item.currentId) || seenInBatch.has(item.currentId)) continue;
        seenInBatch.add(item.currentId);
        toAdd.push(item);
    }

    if (toAdd.length === 0) {
        res.status(200).json({ ok: true, message: 'Wszystkie pozycje już zapisane.', lastChunkName });
        return;
    }

    // 3. Dopisz do chunku, a przy przekroczeniu limitu rozmiaru zacznij kolejny plik
    const filesToUpdate = {};
    let currentName = lastChunkName;
    let currentItems = workingItems.slice();

    for (const item of toAdd) {
        const projectedSize = JSON.stringify(currentItems.concat(item)).length;
        if (projectedSize > CHUNK_LIMIT && currentItems.length > 0) {
            filesToUpdate[currentName] = { content: JSON.stringify(currentItems) };
            chunkIndex++;
            currentName = `chunk_${String(chunkIndex).padStart(4, '0')}.json`;
            currentItems = [];
        }
        currentItems.push(item);
    }
    filesToUpdate[currentName] = { content: JSON.stringify(currentItems) };

    // 4. Zapisz zmienione pliki w gist (tylko te, które faktycznie się zmieniły)
    const patchResp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: { ...apiHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToUpdate })
    });

    if (!patchResp.ok) {
        const errText = await patchResp.text();
        res.status(502).json({ error: 'Zapis do gista nie powiódł się.', details: errText });
        return;
    }

    res.status(200).json({ ok: true, added: toAdd.length, lastChunkName: currentName });
};
