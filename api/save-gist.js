// api/save-gist.js
// Endpoint serverless (Vercel) – dopisuje NOWE pozycje do ostatniego "chunku" w Gist,
// bez pobierania i wysyłania całej dotychczasowej historii przy każdym zapisie.
//
// Wymagane zmienne środowiskowe w ustawieniach projektu na Vercelu:
//   GITHUB_TOKEN  – Personal Access Token ze scope "gist" (Settings -> Environment Variables)
//   GIST_ID       – ID gista, z adresu gist.github.com/TWOJ_LOGIN/TU_JEST_ID
//
// Odczyt aktualnego stanu gista idzie zawsze przez api.github.com (nie przez cache'owany
// "raw" URL), żeby uniknąć odczytania nieaktualnej wersji pliku tuż po poprzednim zapisie.

const CHUNK_LIMIT = 900 * 1024; // bezpieczny margines poniżej limitu ~1MB/plik w Gist API

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const TOKEN = process.env.GITHUB_TOKEN;
    const GIST_ID = process.env.GIST_ID;

    if (!TOKEN || !GIST_ID) {
        res.status(500).json({ error: 'Brak GITHUB_TOKEN / GIST_ID w zmiennych środowiskowych Vercela.' });
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

    // 1. Wczytaj aktualny stan gista przez oficjalne API GitHuba (api.github.com).
    //    WAŻNE: celowo NIE używamy tu "gist.githubusercontent.com/.../raw/<plik>" —
    //    ten adres jest cache'owany przez CDN GitHuba (Fastly) i po świeżym zapisie
    //    potrafi jeszcze przez chwilę zwracać STARĄ wersję pliku. Przy kilku(dziesięciu)
    //    paczkach wysyłanych szybko jedna po drugiej prowadziło to do odczytania
    //    nieaktualnej zawartości i nadpisania (utraty) danych z poprzedniej paczki.
    //    api.github.com zwraca zawsze aktualny stan, więc jest tu bezpieczne.
    const gistResp = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers: apiHeaders });
    if (!gistResp.ok) {
        res.status(502).json({ error: 'Nie udało się pobrać gista.', status: gistResp.status });
        return;
    }
    const gist = await gistResp.json();
    const chunkNames = Object.keys(gist.files).filter(n => /^chunk_\d+\.json$/.test(n)).sort();

    let workingItems = [];
    let chunkIndex = 0;

    if (lastChunkName && gist.files[lastChunkName]) {
        chunkIndex = parseInt((lastChunkName.match(/\d+/) || ['0'])[0], 10);
        const file = gist.files[lastChunkName];
        let content = file.content;
        if (file.truncated) {
            const rawResp = await fetch(file.raw_url, { headers: apiHeaders });
            content = await rawResp.text();
        }
        try { workingItems = JSON.parse(content); } catch { workingItems = []; }
    } else if (chunkNames.length > 0) {
        // klient nie podał lastChunkName (albo podał nieistniejący) -> bierzemy faktycznie ostatni chunk z gista
        lastChunkName = chunkNames[chunkNames.length - 1];
        chunkIndex = parseInt(lastChunkName.match(/\d+/)[0], 10);
        const file = gist.files[lastChunkName];
        let content = file.content;
        if (file.truncated) {
            const rawResp = await fetch(file.raw_url, { headers: apiHeaders });
            content = await rawResp.text();
        }
        try { workingItems = JSON.parse(content); } catch { workingItems = []; }
    } else {
        lastChunkName = 'chunk_0000.json';
        chunkIndex = 0;
        workingItems = [];
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
