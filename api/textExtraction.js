// api/textExtraction.js
import createClient from "@azure-rest/ai-document-intelligence";
import { AzureKeyCredential } from "@azure/core-auth";
import Busboy from "busboy";

/** CORS (relax for testing; lock down origins in prod) */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/** Common analyze helper */
// Tries v4 path first; if Azure returns 404, falls back to v3.1 path.
async function analyzeWithAzure(client, model, contentType, body) {
  // Attempt 1: v4 (Document Intelligence)
  let initial = await client
    .path("/documentintelligence/documentModels/{modelId}:analyze", model)
    .post({
      queryParameters: { "api-version": "2024-11-30", _overload: "analyzeDocument" },
      contentType,
      body,
    });

  // If v4 path isn't available on this resource/region, Azure returns 404 → try v3.1
  if (initial.status === 404) {
    initial = await client
      .path("/formrecognizer/documentModels/{modelId}:analyze", model)
      .post({
        queryParameters: { "api-version": "2023-07-31", _overload: "analyzeDocument" },
        contentType,
        body,
      });
  }

  if (initial.status !== 202) {
    return { ok: false, error: { status: initial.status, details: initial.body } };
  }

  const poller = client.getLongRunningPoller(initial);
  const finalResp = await poller.pollUntilDone();

  if (finalResp.status !== 200) {
    return { ok: false, error: { status: finalResp.status, details: finalResp.body } };
  }

  const r = finalResp.body?.analyzeResult || {};
  return {
    ok: true,
    payload: {
      text: r.content ?? "",
      paragraphs: r.paragraphs ?? [],
      tables: r.tables ?? [],
    },
  };
}


export default async function handler(req, res) {
  setCors(res);

  // CORS preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // Simple health check
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, route: "/api/textExtraction", expects: ["POST multipart/form-data", "POST application/json", "POST application/octet-stream"] });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const endpoint = process.env.AZURE_DI_ENDPOINT;
  const key = process.env.AZURE_DI_KEY;
  if (!endpoint || !key) {
    return res.status(500).json({ error: "Missing AZURE_DI_ENDPOINT or AZURE_DI_KEY" });
    }

  const model = (String(req.query.model || "").toLowerCase() === "layout") ? "prebuilt-layout" : "prebuilt-read";
  const client = createClient(endpoint, new AzureKeyCredential(key));
  const ct = String(req.headers["content-type"] || "").toLowerCase();

  try {
    // --- 1) multipart/form-data (file upload via <input> or Postman form-data) ---
    if (ct.includes("multipart/form-data")) {
      const busboy = Busboy({ headers: req.headers });
      let fileStream = null;

      const parsed = new Promise((resolve, reject) => {
        busboy.on("file", (_field, stream) => { fileStream = stream; });
        busboy.on("error", reject);
        busboy.on("finish", resolve);
        req.pipe(busboy);
      });
      await parsed;

      if (!fileStream) {
        return res.status(400).json({ error: "Expected 'file' in form-data" });
      }

      const result = await analyzeWithAzure(client, model, "application/octet-stream", fileStream);
      if (!result.ok) return res.status(502).json({ error: "Start/Analyze failed", details: result.error.details });
      return res.json(result.payload);
    }

    // --- 2) application/json { url: "https://..." } (public or signed URL) ---
    if (ct.includes("application/json")) {
      const body =
        (typeof req.body === "object" && req.body) ||
        JSON.parse(Buffer.from(await streamToBuffer(req)).toString("utf8") || "{}");
      const fileUrl = body.url;
      if (!fileUrl) return res.status(400).json({ error: "Provide JSON: { url: 'https://...' }" });

      const result = await analyzeWithAzure(client, model, "application/json", { urlSource: fileUrl });
      if (!result.ok) return res.status(502).json({ error: "Start/Analyze failed", details: result.error.details });
      return res.json(result.payload);
    }

    // --- 3) raw binary (Postman 'binary', cURL with --data-binary) ---
    if (
      ct.includes("application/octet-stream") ||
      ct.includes("application/pdf") ||
      ct.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    ) {
      const result = await analyzeWithAzure(client, model, "application/octet-stream", req /* raw stream */);
      if (!result.ok) return res.status(502).json({ error: "Start/Analyze failed", details: result.error.details });
      return res.json(result.payload);
    }

    // Not a supported content-type
    return res.status(415).json({ error: "Use multipart/form-data or application/json" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unexpected error" });
  }
}

// Small helper to read raw body when needed
function streamToBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
