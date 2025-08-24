// server.js
const express = require("express");
const cheerio = require("cheerio");
const axios = require("axios");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;

// ---- Google Cloud Translation 初期化 ----
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const projectId = process.env.GOOGLE_PROJECT_ID;
const location = "global";

const translationClient = new TranslationServiceClient({
  projectId,
  credentials,
});

// ---- Express 初期設定 ----
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

// ---- 文を分割する関数（略語対応）----
function splitSentences(text) {
  const abbrevs = ["Mr","Mrs","Ms","Dr","St","Prof","etc","i.e","e.g","vs"];
  const regex = new RegExp(
    "\\b(?:" + abbrevs.join("|") + ")\\.$|" +
    "([.!?])\\s+(?=[A-Z])",
    "g"
  );

  let sentences = [];
  let start = 0;
  text.replace(regex, (match, punct, offset) => {
    sentences.push(text.slice(start, offset + (punct ? 1 : 0)).trim());
    start = offset + match.length;
    return match;
  });
  if (start < text.length) sentences.push(text.slice(start).trim());
  return sentences.filter(s => s.length > 0);
}

// ---- ページごとの文キャッシュ ----
const pageCache = {};

// ---- Google Cloud Translation を使った翻訳関数 ----
async function translateText(text, targetLang = "ja") {
  const request = {
    parent: `projects/${projectId}/locations/${location}`,
    contents: [text],
    mimeType: "text/plain",
    targetLanguageCode: targetLang,
  };

  const [response] = await translationClient.translateText(request);
  return response.translations[0].translatedText;
}

// ---- EventSource でストリーム翻訳 ----
app.get("/api/translate-stream", async (req, res) => {
  const url = req.query.url;
  const start = parseInt(req.query.start || "0", 10);
  if (!url) return res.status(400).send("url required");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (res.flushHeaders) res.flushHeaders();

  try {
    let sentences;
    if (pageCache[url]) {
      sentences = pageCache[url];
    } else {
      const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const $ = cheerio.load(data);
      let originalText = "";
      $("ol li").each((i, el) => {
        let t = $(el).text().replace(/\s+/g, " ");
        originalText += t + " ";
      });
      if (!originalText.trim()) {
        $("p").each((i, el) => {
          let t = $(el).text().replace(/\s+/g, " ");
          originalText += t + " ";
        });
      }
      sentences = splitSentences(originalText);
      pageCache[url] = sentences;
    }

    const batchSize = 3;
    const maxBatchSentences = 100;
    const end = Math.min(sentences.length, start + maxBatchSentences);

    for (let i = start; i < end; i += batchSize) {
      const batch = sentences.slice(i, i + batchSize).join(" ");
      let jaBatch;
      try {
        jaBatch = await translateText(batch, "ja");
      } catch (err) {
        console.error("Translation error:", err);
        jaBatch = "(翻訳失敗)";
      }

      res.write(`data: ${JSON.stringify({
        index: i,
        original: sentences.slice(i, i + batchSize).join(" "),
        text: jaBatch
      })}\n\n`);

      await new Promise(r => setTimeout(r, 100));
    }

    res.write("event: done\ndata: \n\n");
    res.end();
  } catch (err) {
    console.error("Fetch/Translate error:", err.message);
    res.write(`event: error\ndata: ${JSON.stringify(err.message)}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
