// Talks to walmart.ca internal GraphQL persisted queries. Must run inside a
// walmart.ca page so cookies and the PerimeterX clearance are sent.
// Endpoint details: docs/walmart-ca-endpoints.md
import { parseStores, parseItem } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.walmart.ca";
const NEARBY_HASH = "d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f";
const ITEM_HASH = "dd90c309e2b4c9418dc5050720b5f8c8520e593aaf942fd2c7f6321ea820d500";
const SET_PICKUP_HASH = "6a6546328078a19211cd19fa5cc944c0ab3391debe1921175575027f42fcb726";

// Booleans the ItemById persisted query declares as Boolean! (all false = minimal payload).
const ITEM_FLAGS = ["fRev", "spSBA", "sVC", "enableImageClassification", "adV1Enabled", "eItIb", "fIlc",
  "enableDetailedBeacon", "fSeo", "fP13", "sV", "spVid", "fGalAd", "fMrkDscrp", "fSCar", "fBB", "eSb", "sIdml",
  "eLLBBAds", "fBBAd", "enableTopReasonsToBuy", "fFit", "fIdml", "fSL", "eCc", "fSId", "fMq", "eSsm", "fAff",
  "enableRelatedSearch", "fDac"];

export function buildHeaders(opName) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-o-platform": "rweb",
    "x-o-bu": "WALMART-CA",
    "x-o-mart": "B2C",
    "x-o-segment": "oaoh",
    "x-o-ccm": "server",
    wm_mp: "true",
    "x-apollo-operation-name": opName,
    "x-o-gql-query": `${opName === "setPickup" ? "mutation" : "query"} ${opName}`,
  };
}

// Either a postal code (geo = null) or a point: geo = {lat, lon, radiusKm}.
// Walmart accepts maxCount 5..50 and radius 1..100 km; a point overrides the postal code.
export function buildNearByNodesUrl(postalCode, itemId, maxCount = 10, geo = null) {
  const variables = {
    input: {
      postalCode: geo ? null : postalCode,
      accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],
      nodeTypes: ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
      latitude: geo?.lat ?? null, longitude: geo?.lon ?? null, radius: geo?.radiusKm ?? null,
      productId: String(itemId),
      maxCount,
    },
    checkItemAvailability: true,
    checkWeeklyReservation: false,
    enableStoreSelectorMarketplacePickup: false,
    enableVisionStoreSelector: false,
    enableStorePagesAndFinderPhase2: false,
    enableStoreBrandFormat: false,
    disableNodeAddressPostalCode: false,
    enableWICStoreSelector: false,
    enableSparkStore: false,
  };
  return `${ORIGIN}/orchestra/graphql/nearByNodes/${NEARBY_HASH}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}

export function buildItemUrl(itemId) {
  const variables = {
    iId: String(itemId), tenant: "CA_GLASS", channel: "WWW", version: "v1",
    pageType: "ItemPageGlobalDesktop", isMobile: false, postProcessingVersion: 1,
  };
  for (const k of ITEM_FLAGS) variables[k] = false;
  return `${ORIGIN}/orchestra/pdp/graphql/ItemById/${ITEM_HASH}/ip/${encodeURIComponent(String(itemId))}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}

export function buildSetPickupBody(store, postalCode) {
  return {
    variables: {
      input: {
        accessPointId: store.accessPointId,
        cartId: "00000000-0000-0000-0000-000000000000",
        postalCode,
        storeId: Number(store.id),
        enableLiquorBox: false,
        enableCartSplitClarity: true,
        features: ["lmpdel"],
      },
    },
  };
}

// Performs the request and returns parsed JSON, or throws WalmartApiError.
async function gql(url, opName, init = {}) {
  const res = await globalThis.fetch(url, { credentials: "include", ...init, headers: buildHeaders(opName) });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || res.status === 412 || /text\/html/i.test(contentType) || /^\s*</.test(text)) {
    throw new WalmartApiError("verification");
  }
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(itemId) {
  return parseItem(await gql(buildItemUrl(itemId), "ItemById"));
}

export async function findStores(postalCode, itemId, maxCount = 10) {
  return parseStores(await gql(buildNearByNodesUrl(postalCode, itemId, maxCount), "nearByNodes"));
}

// The maxCount stores nearest a point within radiusKm (walmart caps radius at 100), with availability.
export async function findStoresAround(lat, lon, itemId, radiusKm = 100, maxCount = 50) {
  return parseStores(await gql(buildNearByNodesUrl(null, itemId, maxCount, { lat, lon, radiusKm }), "nearByNodes"));
}

export async function selectStore(store, postalCode) {
  const json = await gql(`${ORIGIN}/orchestra/graphql/setPickup/${SET_PICKUP_HASH}`, "setPickup", {
    method: "POST",
    body: JSON.stringify(buildSetPickupBody(store, postalCode)),
  });
  const storeId = json?.data?.fulfillmentMutations?.setPickup?.fulfillment?.pickupStore?.storeId;
  if (storeId == null) throw apiChanged(JSON.stringify(json));
  return { storeId: String(storeId) };
}
