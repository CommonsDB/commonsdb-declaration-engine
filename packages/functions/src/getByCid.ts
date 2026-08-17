import { getContentByCID } from "@commonsdb/core/searchUtils/tableCidsUtil";
import { ApiHandler } from "sst/node/api";
import { Config } from "sst/node/config";

const getOptOutMessage = () => {
  return {
    TDMAI: false,
    TDMAI_summary: "Content must not be used for AI training purposes.",
    TDMAI_policy:
      "Automated analysis of the work to extract information from it, especially about patterns, trends and correlations for the purpose of training models and applications of generative AI, is reserved - Text and Data Mining for other than scientific research purposes or for temporary acts of reproduction provided for in Article 5(1) of Directive 2001/29/EC is not permitted.",
  };
};

const getOptInMessage = () => {
  return {
    TDMAI: true,
    TDMAI_summary: "Content may be used for AI training purposes.",
    TDMAI_policy:
      "A reservation against the automated analysis of the work in order to extract information from it, in particular about patterns, trends and correlations for the purpose of training models and applications of generative AI, is not declared - Text and Data Mining is also permitted for other than scientific research purposes or for temporary acts of reproduction provided for in Article 5(1) of Directive 2001/29/EC.",
  };
};

// requires getting an ISCC based on companyID and ISCC code ,
// returns only the publicMetadata from s3 directly
export const getByCid = ApiHandler(async (_evt) => {
  if (!_evt.headers["x-api-key"] || _evt.headers["x-api-key"] !== Config.SECRET_ZUPLO_ACCESS_KEY) {
    return {
      statusCode: 401,
      body: "Unauthorized",
    };
  }
  console.log(Config.VERSION);
  const cid = _evt.queryStringParameters?.cid || "";
  if (cid === "") {
    return { statusCode: 400, body: "Invalid request (missing cid)" };
  }
  if (cid.trim().toLowerCase() === "optout") {
    return {
      statusCode: 200,
      body: JSON.stringify(getOptOutMessage()),
    };
  }
  if (cid.trim().toLowerCase() === "optin") {
    return {
      statusCode: 200,
      body: JSON.stringify(getOptInMessage()),
    };
  }

  const isValidCID = (cid: string) => {
    //<-- shortcut to avoid regex checks that we don't care about for now.
    return cid.trim().length > 4 && cid.trim().length < 100;
    // example:  QmRDs7Z122x79qUYJH3hFmAKiMUaMNpNQUtkE95jHRyLL5
    // IPFS CID v0 is a base58-encoded multihash, typically 46 characters long
    // IPFS CID v1 is a base32-encoded multihash, typically 59 characters long
    // const cidV0Pattern = /^Qm[1-9A-HJ-NP-Za-km-z]{45}$/;
    // const cidV1Pattern = /^[b][a-z2-7]{58}$/;
    // const cidV2Pattern = /^[Qm][1-9A-HJ-NP-Za-km-z]{46}$/; //our own thing
    // const customCidPattern = /^dj[a-zA-Z0-9]{46}$/; // new pattern for the provided CID
    // return cidV0Pattern.test(cid) || cidV1Pattern.test(cid) || cidV2Pattern.test(cid) || customCidPattern.test(cid);
  };

  if (!isValidCID(cid)) {
    return { statusCode: 400, body: "Invalid CID: " + cid };
  }

  try {
    //get directly from dynamo:
    const content = await getContentByCID(cid);
    if (!content) {
      return { statusCode: 404, body: "Not found" };
    }
    return { statusCode: 200, body: content };
  } catch (err) {
    console.error("Error getting from S3:", err);
    throw err;
  }
});
