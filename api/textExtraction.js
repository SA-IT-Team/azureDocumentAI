// api/textextraction.js
import createClient from "@azure-rest/ai-document-intelligence";
import { AzureKeyCredential } from "@azure/core-auth";
import Busboy from "busboy";

/** Simple CORS helper — in prod, set to your domain(s) instead of "*" */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const endpoint = process.env.AZURE_DI_ENDPOINT;
  const key = process.env.AZURE_DI_KEY;
  if (!endpoint || !key) {
    return res.status(500).json({ error: "Missing AZURE_DI_ENDPOINT or AZURE_DI_KEY" });
  }

  const model = req.query.model === "layout" ? "prebuilt-layout" : "prebuilt-read";
  const client = createClient(endpoint, new AzureKeyCredential(key));
  const ct = String(req.headers["content-type"] || "");

  try {
    // --- 1) multipart/form-data (file upload) ---
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

      if (!fileStream) return res.status(400).json({ error: "Expected 'file' in form-data" });

      const initial = await client
        .path("/documentintelligence/documentModels/{modelId}:analyze", model)
        .post({
          queryParameters: { "api-version": "2024-11-30" },
          contentType: "application/octet-stream",
          body: fileStream
        });

      if (initial.status !== "202") {
        return res.status(502).json({ error: "Start failed", details: initial.body });
      }

      const poller = client.getLongRunningPoller(initial);
      const finalResp = await poller.pollUntilDone();
      if (finalResp.status !== "200") {
        return res.status(502).json({ error: "Analyze failed", details: finalResp.body });
      }

      const result = finalResp.body?.analyzeResult;
      return res.json({
        text: result?.content ?? "",
        paragraphs: result?.paragraphs ?? [],
        tables: result?.tables ?? []
      });
    }

    // --- 2) application/json { url: "https://..." } ---
    if (ct.includes("application/json")) {
      const body = typeof req.body === "object" && req.body ? req.body
                 : JSON.parse(Buffer.from(await streamToBuffer(req)).toString("utf8") || "{}");
      const fileUrl = body.url;
      if (!fileUrl) return res.status(400).json({ error: "Provide JSON: { url: 'https://...' }" });

      const initial = await client
        .path("/documentintelligence/documentModels/{modelId}:analyze", model)
        .post({
          queryParameters: { "api-version": "2024-11-30" },
          contentType: "application/json",
          body: { urlSource: fileUrl }
        });

      if (initial.status !== "202") {
        return res.status(502).json({ error: "Start failed", details: initial.body });
      }

      const poller = client.getLongRunningPoller(initial);
      const finalResp = await poller.pollUntilDone();
      if (finalResp.status !== "200") {
        return res.status(502).json({ error: "Analyze failed", details: finalResp.body });
      }

      const result = finalResp.body?.analyzeResult;
      return res.json({
        text: result?.content ?? "",
        paragraphs: result?.paragraphs ?? [],
        tables: result?.tables ?? []
      });
    }

    return res.status(415).json({ error: "Use multipart/form-data or application/json" });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unexpected error" });
  }
}

// Helper for raw body capture (URL mode fallback)
function streamToBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
