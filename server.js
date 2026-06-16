const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({ origin: "*" }));

const limiter = rateLimit({ windowMs: 60000, max: 30 });
app.use("/api/", limiter);

const bhulekhClient = axios.create({
  baseURL: "https://upbhulekh.gov.in/public/public_ror",
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://upbhulekh.gov.in/public/public_ror/Public_ROR.jsp",
  },
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date() }));

app.get("/api/villages", async (req, res) => {
  const { districtId, tehsilId } = req.query;
  if (!districtId || !tehsilId) return res.status(400).json({ error: "Missing params" });
  try {
    const response = await bhulekhClient.get("/Public_ROR.jsp", {
      params: { district_id: districtId, tehsil_id: tehsilId, type: "village" },
    });
    const $ = cheerio.load(response.data);
    const villages = [];
    $("option").each((_, el) => {
      const val = $(el).attr("value");
      const name = $(el).text().trim();
      if (val && val !== "0" && name) villages.push({ id: val, name });
    });
    res.json({ villages });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch villages", detail: err.message });
  }
});

app.post("/api/captcha", async (req, res) => {
  const { districtId, tehsilId, villageId } = req.body;
  try {
    const pageRes = await bhulekhClient.get("/Public_ROR.jsp", {
      params: { district_id: districtId, tehsil_id: tehsilId, village_id: villageId },
    });
    const $ = cheerio.load(pageRes.data);
    let captchaUrl = $("img").filter((_, el) => {
      const src = $(el).attr("src") || "";
      return src.toLowerCase().includes("captcha") || src.toLowerCase().includes("verify");
    }).first().attr("src");

    if (!captchaUrl) return res.status(404).json({ error: "CAPTCHA not found" });
    if (!captchaUrl.startsWith("http")) {
      captchaUrl = "https://upbhulekh.gov.in" + (captchaUrl.startsWith("/") ? "" : "/public/public_ror/") + captchaUrl;
    }
    const imgRes = await axios.get(captchaUrl, {
      responseType: "arraybuffer",
      headers: { "Cookie": pageRes.headers["set-cookie"]?.join("; ") || "" },
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const contentType = imgRes.headers["content-type"] || "image/png";
    res.json({
      captchaImage: `data:${contentType};base64,${base64}`,
      sessionCookies: (pageRes.headers["set-cookie"] || []).join("; "),
    });
  } catch (err) {
    res.status(502).json({ error: "CAPTCHA failed", detail: err.message });
  }
});

app.post("/api/search", async (req, res) => {
  const { districtId, tehsilId, villageId, searchType, searchValue, captcha, sessionCookies } = req.body;
  if (!districtId || !tehsilId || !villageId || !captcha) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const searchTypeMap = { name: "khatedar", khasra: "khasrano", khata: "khatano" };
    const formData = new URLSearchParams({
      district_id: districtId, tehsil_id: tehsilId, village_id: villageId,
      search_type: searchTypeMap[searchType] || "khatedar",
      search_value: searchValue, captchaCode: captcha,
    });
    const response = await bhulekhClient.post("/action/CaptchaMatch", formData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": sessionCookies || "",
        "Origin": "https://upbhulekh.gov.in",
      },
    });
    const $ = cheerio.load(response.data);
    const records = [];
    $("table tr").each((rowIdx, row) => {
      if (rowIdx === 0) return;
      const cells = $(row).find("td");
      if (cells.length < 3) return;
      const rec = {
        khasraNo: $(cells[1]).text().trim(),
        khataNo: $(cells[2]).text().trim(),
        khatedarName: $(cells[3]).text().trim(),
        area: $(cells[4]).text().trim(),
        landType: $(cells[5]).text().trim(),
      };
      if (rec.khatedarName || rec.khasraNo) records.push(rec);
    });
    res.json({ records, count: records.length });
  } catch (err) {
    res.status(502).json({ error: "Search failed", detail: err.message });
  }
});

app.get("/api/bhunaksha", async (req, res) => {
  const { districtId, tehsilId, villageId, khasraNo } = req.query;
  try {
    const response = await axios.get("https://upbhunaksha.gov.in/bhunaksha/map", {
      params: {
        SERVICE: "WFS", VERSION: "1.1.0", REQUEST: "GetFeature",
        TYPENAME: "up:UP_PLOT", OUTPUTFORMAT: "application/json",
        CQL_FILTER: `DISTRICT_ID='${districtId}' AND TEHSIL_ID='${tehsilId}' AND VILLAGE_ID='${villageId}' AND KHASRA_NO='${khasraNo}'`,
      },
      timeout: 10000,
      headers: { "Referer": "https://upbhunaksha.gov.in/" },
    });
    const geojson = response.data;
    if (!geojson.features || geojson.features.length === 0) {
      return res.json({ found: false });
    }
    const feature = geojson.features[0];
    const coords = feature.geometry.type === "Polygon"
      ? feature.geometry.coordinates[0]
      : feature.geometry.coordinates[0][0];
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    res.json({
      found: true,
      coordinates: coords,
      centerLat: (Math.min(...lats) + Math.max(...lats)) / 2,
      centerLng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
      area: feature.properties?.AREA_HECT || null,
    });
  } catch (err) {
    res.json({ found: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
