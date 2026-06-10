require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const {
  SKYSLOPE_BASE_URL,
  SKYSLOPE_CLIENT_ID,
  SKYSLOPE_CLIENT_SECRET,
  SKYSLOPE_ACCESS_KEY,
  SKYSLOPE_ACCESS_SECRET,
  WEBHOOK_SHARED_SECRET,
  DEFAULT_EMAIL_DOMAIN = "agentcollective.com",
  DEFAULT_PHONE_AREA_CODE = "480",

  DEFAULT_AGENT_GUID = "399e92d1-08dd-4f5b-bd47-a3c8fcb4747e",
  DEFAULT_OFFICE_GUID = "fb6a399d-d3c6-4649-b67d-81522233b0c9",
  DEFAULT_CHECKLIST_TYPE_ID = "117936",

  DEFAULT_PROPERTY_TYPE = "Residential",
  DEFAULT_PROPERTY_SUBTYPE = "Other",
  DEFAULT_PROPERTY_TYPE_ID = "501",
  DEFAULT_PROPERTY_SUBTYPE_ID = "522",
  DEFAULT_DEAL_TYPE = "Purchase",
  DEFAULT_SALE_TYPE_ID = "32",
  DEFAULT_IS_OFFICE_LEAD = "false",

  DEFAULT_TC_FIRST_NAME = "Amy",
  DEFAULT_TC_LAST_NAME = "Zabel",
  DEFAULT_TC_EMAIL = "TransactionSupport@agentcollective.com",
  DEFAULT_TC_PHONE = "6232290968",
  DEFAULT_TC_COMPANY = ""
} = process.env;

let sessionCache = {
  token: null,
  expiresAt: 0
};

function cleanString(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

function normalizeName(firstName, lastName, fullName) {
  const first = cleanString(firstName);
  const last = cleanString(lastName);
  const full = cleanString(fullName);

  if (first && last) {
    return {
      firstName: first,
      lastName: last,
      fullName: `${first} ${last}`.trim()
    };
  }

  if (full) {
    const parts = full.replace(/\s+/g, " ").split(" ").filter(Boolean);
    let resolvedFirst = parts[0] || "Unknown";
    const resolvedLast = parts.slice(1).join(" ") || "Client";

    if (resolvedFirst.toLowerCase() === "jeff") {
      resolvedFirst = "Geoff";
    }

    return {
      firstName: resolvedFirst,
      lastName: resolvedLast,
      fullName: `${resolvedFirst} ${resolvedLast}`.trim()
    };
  }

  return {
    firstName: "Unknown",
    lastName: "Client",
    fullName: "Unknown Client"
  };
}

function normalizeEmail(rawEmail, fullName) {
  const cleaned = cleanString(rawEmail).toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (emailRegex.test(cleaned)) {
    return cleaned;
  }

  const fallbackSlug = slugify(fullName) || "unknown.client";
  return `${fallbackSlug}.${Date.now()}@${DEFAULT_EMAIL_DOMAIN}`;
}

function normalizePhone(rawPhone) {
  let digits = String(rawPhone || "").replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length === 7) {
    digits = `${DEFAULT_PHONE_AREA_CODE}${digits}`;
  }

  if (digits.length > 10) {
    digits = digits.slice(0, 10);
  }

  if (digits.length < 10) {
    digits = (`${DEFAULT_PHONE_AREA_CODE}${digits}`).padEnd(10, "0").slice(0, 10);
  }

  return digits;
}

function normalizeAttachments(input) {
  let attachments = input;

  if (typeof attachments === "string") {
    attachments = JSON.parse(attachments);
  }

  if (!Array.isArray(attachments)) {
    throw new Error("Attachments payload must be an array or JSON string.");
  }

  const normalized = attachments
    .filter(Boolean)
    .map((a, idx) => {
      const url = cleanString(a.url);
      let fileName = cleanString(a.fileName || `attachment_${idx + 1}.pdf`);
      const mimeType = cleanString(a.mimeType || "application/pdf");

      if (!url) return null;

      if (!fileName.toLowerCase().endsWith(".pdf")) {
        fileName += ".pdf";
      }

      fileName = fileName.replace(/[^\w.\- ()]/g, " ").replace(/\s+/g, " ").trim();

      if (fileName.length > 150) {
        fileName = fileName.slice(0, 146).trim() + ".pdf";
      }

      return { url, fileName, mimeType };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error("No valid attachments after normalization.");
  }

  return normalized;
}

function summarizeAxiosError(error) {
  return {
    message: error.message,
    status: error.response?.status || null,
    statusText: error.response?.statusText || null,
    data: error.response?.data || null
  };
}

function buildSkySlopeAuthHeader() {
  const timestamp = new Date().toISOString();
  const input = `${SKYSLOPE_CLIENT_ID}:${SKYSLOPE_CLIENT_SECRET}:${timestamp}`;
  const hmac = crypto
    .createHmac("sha256", SKYSLOPE_ACCESS_SECRET)
    .update(input)
    .digest("base64");

  return {
    timestamp,
    authorization: `SS ${SKYSLOPE_ACCESS_KEY}:${hmac}`
  };
}

async function getSkySlopeSession() {
  const now = Date.now();

  if (sessionCache.token && now < sessionCache.expiresAt - 60000) {
    return sessionCache.token;
  }

  const auth = buildSkySlopeAuthHeader();

  const response = await axios.post(
    `${SKYSLOPE_BASE_URL}/auth/login`,
    {
      clientID: SKYSLOPE_CLIENT_ID,
      clientSecret: SKYSLOPE_CLIENT_SECRET
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Timestamp": auth.timestamp,
        "Authorization": auth.authorization
      }
    }
  );

  const session = response.data?.Session || response.data?.session;
  const expiration = response.data?.Expiration || response.data?.expiration;

  if (!session) {
    throw new Error(`SkySlope login failed. Unexpected response: ${JSON.stringify(response.data)}`);
  }

  sessionCache.token = session;
  sessionCache.expiresAt = expiration
    ? new Date(expiration).getTime()
    : Date.now() + 110 * 60 * 1000;

  return sessionCache.token;
}

async function skySlopeRequest(method, path, data = null, params = null) {
  const session = await getSkySlopeSession();

  const response = await axios({
    method,
    url: `${SKYSLOPE_BASE_URL}${path}`,
    data,
    params,
    headers: {
      "Content-Type": "application/json",
      "Session": session
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return response.data;
}

async function downloadFileAsBase64(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data).toString("base64");
}

function todayLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00`;
}

function buildCreateSalePayload(overrides = {}) {
  return {
    officeGuid: DEFAULT_OFFICE_GUID,
    agentGuid: DEFAULT_AGENT_GUID,
    checklistTypeId: Number(DEFAULT_CHECKLIST_TYPE_ID),

    contractAcceptanceDate: todayLocalDateString(),
    salePrice: 0,
    isOfficeLead: false,

    sourceId: 131,
    otherSource: "Buyer Broker Upload Automation",

    ...overrides
  };
}

async function createPreContractSale(payloadOverrides = {}) {
  const payload = buildCreateSalePayload(payloadOverrides);
  const result = await skySlopeRequest("post", "/api/files/sales", payload);
  const sale = result?.value?.sale || result?.sale || result?.value || result;
  const saleGuid = sale?.saleGuid || result?.saleGuid || result?.id || null;

  if (!saleGuid) {
    throw new Error(`Could not determine saleGuid from create response: ${JSON.stringify(result)}`);
  }

  return {
    payload,
    result,
    saleGuid
  };
}

async function addBuyerToSale(saleGuid, buyer) {
  const payload = {
    company: "",
    firstName: buyer.firstName,
    lastName: buyer.lastName,
    email: buyer.email,
    phoneNumber: buyer.phone
  };

  return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/buyerContact`, payload);
}

async function updateSaleCommissions(saleGuid) {
  const payload = {
    transactionCoordinatorName: `${DEFAULT_TC_FIRST_NAME} ${DEFAULT_TC_LAST_NAME}`,
    transactionCoordinatorFee: null,
    dateOfCheck: null,
    datePostedToLogBook: null,
    listingCommissionPercent: null,
    listingCommissionAmount: null,
    saleCommissionPercent: null,
    saleCommissionAmount: null,
    otherDeductions: null,
    personalDeal: false,
    commissionBreakdownDetails: null,
    officeGrossCommissionOnSale: null
  };

  return await skySlopeRequest("put", `/api/files/sales/${saleGuid}/commissions`, payload);
}

async function uploadDocumentToSale(saleGuid, attachment) {
  const base64Content = await downloadFileAsBase64(attachment.url);

  const payload = {
    fileName: attachment.fileName,
    base64Content
  };

  return await skySlopeRequest("post", `/api/files/sales/${saleGuid}/documents`, payload);
}

async function getSaleByGuid(saleGuid) {
  return await skySlopeRequest("get", `/api/files/sales/${saleGuid}`);
}

function okResponse(res, body) {
  return res.status(200).json(body);
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "SkySlope middleware running" });
});

app.get("/auth-test", async (req, res) => {
  try {
    const session = await getSkySlopeSession();
    return okResponse(res, {
      ok: true,
      message: "SkySlope authentication successful",
      sessionPreview: String(session).slice(0, 8) + "..."
    });
  } catch (error) {
    return okResponse(res, {
      ok: false,
      step: "auth-test",
      error: summarizeAxiosError(error)
    });
  }
});

app.get("/debug/create-payload", (req, res) => {
  return okResponse(res, {
    ok: true,
    payload: buildCreateSalePayload()
  });
});

app.post("/debug/test-create-sale", async (req, res) => {
  try {
    const result = await createPreContractSale(req.body || {});
    return okResponse(res, {
      ok: true,
      step: "create-sale",
      saleGuid: result.saleGuid,
      payload: result.payload,
      result: result.result
    });
  } catch (error) {
    return okResponse(res, {
      ok: false,
      step: "create-sale",
      payloadTried: buildCreateSalePayload(req.body || {}),
      error: summarizeAxiosError(error)
    });
  }
});

app.post("/api/skyslope-upload", async (req, res) => {
  const debug = [];
  let saleGuid = null;

  try {
    const sharedSecret = req.headers["x-shared-secret"];

    if (sharedSecret !== WEBHOOK_SHARED_SECRET) {
      return okResponse(res, {
        ok: false,
        step: "auth",
        error: "Unauthorized"
      });
    }

    const clientName = normalizeName(
      req.body.clientFirstName,
      req.body.clientLastName,
      req.body.clientFullName
    );

    const buyer = {
      company: "",
      firstName: clientName.firstName,
      lastName: clientName.lastName,
      fullName: clientName.fullName,
      email: normalizeEmail(req.body.clientEmail, clientName.fullName),
      phone: normalizePhone(req.body.clientPhone)
    };

    const agent = {
      fullName: cleanString(req.body.agentFullName),
      email: cleanString(req.body.agentEmail)
    };

    const attachments = normalizeAttachments(
      req.body.attachments || req.body.attachmentsJson
    );

    debug.push({
      step: "input-normalized",
      buyer,
      agent,
      attachmentCount: attachments.length
    });

    let createResult;
    try {
      createResult = await createPreContractSale();
      saleGuid = createResult.saleGuid;
      debug.push({
        step: "sale-created",
        saleGuid,
        payload: createResult.payload,
        result: createResult.result
      });
    } catch (createError) {
      return okResponse(res, {
        ok: false,
        step: "create-sale",
        saleGuid: null,
        payloadTried: buildCreateSalePayload(),
        error: summarizeAxiosError(createError),
        debug
      });
    }

    try {
      const buyerResult = await addBuyerToSale(saleGuid, buyer);
      debug.push({
        step: "buyer-added",
        result: buyerResult
      });
    } catch (buyerError) {
      debug.push({
        step: "buyer-add-failed",
        error: summarizeAxiosError(buyerError)
      });
    }

    try {
      const commissionResult = await updateSaleCommissions(saleGuid);
      debug.push({
        step: "tc-updated",
        result: commissionResult
      });
    } catch (tcError) {
      debug.push({
        step: "tc-update-failed",
        error: summarizeAxiosError(tcError)
      });
    }

    const uploaded = [];
    for (const attachment of attachments) {
      try {
        const result = await uploadDocumentToSale(saleGuid, attachment);
        uploaded.push({
          fileName: attachment.fileName,
          uploaded: true,
          result
        });
      } catch (uploadError) {
        uploaded.push({
          fileName: attachment.fileName,
          uploaded: false,
          error: summarizeAxiosError(uploadError)
        });
      }
    }

    const uploadedSuccessCount = uploaded.filter(x => x.uploaded).length;
    const uploadedFailCount = uploaded.filter(x => !x.uploaded).length;

    let saleDetail = null;
    try {
      saleDetail = await getSaleByGuid(saleGuid);
      debug.push({
        step: "sale-detail",
        result: saleDetail
      });
    } catch (detailError) {
      debug.push({
        step: "sale-detail-failed",
        error: summarizeAxiosError(detailError)
      });
    }

    return okResponse(res, {
      ok: true,
      step: "complete",
      saleGuid,
      uploadedCount: uploadedSuccessCount,
      failedUploadCount: uploadedFailCount,
      uploaded,
      summaryText: `SkySlope upload completed for ${buyer.fullName}. Created pre-contract purchase file. Uploaded ${uploadedSuccessCount} document(s). Failed uploads: ${uploadedFailCount}.`,
      debug
    });
  } catch (error) {
    return okResponse(res, {
      ok: false,
      step: "unhandled",
      saleGuid,
      error: summarizeAxiosError(error),
      debug
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
