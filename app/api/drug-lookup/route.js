/**
 * Drug Lookup API Proxy
 *
 * Proxies all /api/drug-lookup/* requests to the Python backend so that
 * the backend URL (MEDICAL_PIPELINE_URL) is never exposed to the browser.
 *
 * Usage from the frontend:
 *   GET  /api/drug-lookup?path=search&q=paracetamol
 *   GET  /api/drug-lookup?path=info/Dolo%20650
 *   GET  /api/drug-lookup?path=alternatives/Augmentin%20625
 *   GET  /api/drug-lookup?path=autocomplete&q=aug
 *   GET  /api/drug-lookup?path=pharmacies&lat=17.385&lon=78.486&radius=3000
 *   GET  /api/drug-lookup?path=safety/ibuprofen
 */

const BACKEND_URL =
  process.env.MEDICAL_PIPELINE_URL || "http://localhost:8000";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    // Extract the target path and remove it from the forwarded query string
    const path = searchParams.get("path") || "";
    searchParams.delete("path");

    const forwardedParams = searchParams.toString();
    const backendUrl = `${BACKEND_URL}/api/drug-lookup/${path}${
      forwardedParams ? `?${forwardedParams}` : ""
    }`;

    const backendResponse = await fetch(backendUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "MedSync-AI-Frontend/1.0",
      },
      // 30-second timeout to accommodate Overpass API calls
      signal: AbortSignal.timeout(30_000),
    });

    const data = await backendResponse.json();

    return Response.json(data, { status: backendResponse.status });
  } catch (error) {
    // AbortError = timeout
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return Response.json(
        { error: "Request Timed Out. Please Try Again." },
        { status: 504 }
      );
    }

    console.error("[Drug Lookup Proxy] Error:", error);
    return Response.json(
      {
        error: "Drug Lookup Service Unavailable. Make Sure the Backend is Running.",
        detail: error.message,
      },
      { status: 503 }
    );
  }
}
