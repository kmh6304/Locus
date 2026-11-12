export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({ status: "ok", service: "Locus Address Search" });
    }

    if (url.pathname !== "/geocode") {
      return json({ error: "Not found" }, 404);
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const query = (url.searchParams.get("q") || "").trim();

    if (!query) {
      return json({ error: "검색할 주소를 입력해 줘." }, 400);
    }

    if (!env.NAVER_MAPS_KEY_ID || !env.NAVER_MAPS_KEY) {
      return json({ error: "네이버 API 인증정보가 설정되지 않았어." }, 500);
    }

    function extractLotNumber(address) {
      const normalized = (address || "").replace(/\s+/g, " ").trim();
      const match = normalized.match(
        /(?:동|리|읍|면)\s+(?:산\s*)?(\d+(?:-\d+)?)(?=\s|$)/
      );
      return match ? match[1] : null;
    }

    const compactQuery = query.replace(/\s+/g, "");
    const looksLikeRoadAddress = /(대로|로|길)\d/.test(compactQuery);
    const lotMatch = compactQuery.match(/(\d+(?:-\d+)?)$/);
    const requestedLot = !looksLikeRoadAddress && lotMatch ? lotMatch[1] : null;

    const spacedQuery = compactQuery
      .replace(
        /(특별자치도|특별자치시|특별시|광역시|자치구|시|군|구|읍|면|동|리)(?=[가-힣0-9])/g,
        "$1 "
      )
      .replace(/([가-힣])([0-9]+(?:-[0-9]+)?$)/, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();

    const candidates = [...new Set(
      requestedLot
        ? [spacedQuery, query, compactQuery]
        : [query, spacedQuery, compactQuery]
    )].filter(Boolean).slice(0, 4);

    try {
      const collected = new Map();
      const attemptedQueries = [];
      const rawResponses = [];

      for (const candidate of candidates) {
        attemptedQueries.push(candidate);

        const naverUrl = new URL(
          "https://maps.apigw.ntruss.com/map-geocode/v2/geocode"
        );
        naverUrl.searchParams.set("query", candidate);

        const response = await fetch(naverUrl.toString(), {
          method: "GET",
          headers: {
            "x-ncp-apigw-api-key-id": env.NAVER_MAPS_KEY_ID,
            "x-ncp-apigw-api-key": env.NAVER_MAPS_KEY,
            "Accept": "application/json",
          },
        });

        const result = await response.json();

        if (!response.ok) {
          return json({
            error: "네이버 Geocoding API 호출 실패",
            status: response.status,
            detail: result,
            attemptedQueries,
          }, 502);
        }

        const rawAddresses = result.addresses || [];
        rawResponses.push({
          query: candidate,
          totalCount: result.meta?.totalCount ?? rawAddresses.length,
          addresses: rawAddresses,
        });

        console.log(
          "NAVER RAW RESULT:",
          JSON.stringify(rawResponses[rawResponses.length - 1])
        );

        for (const address of rawAddresses) {
          const jibun = (address.jibunAddress || "").trim();

          if (requestedLot) {
            const resultLot = extractLotNumber(jibun);
            if (resultLot !== requestedLot) continue;
          }

          const key = `${address.x || ""}|${address.y || ""}`;
          if (key !== "|" && !collected.has(key)) {
            collected.set(key, address);
          }
        }

        if (collected.size > 0) break;
      }

      const addresses = [...collected.values()];

      return json({
        success: true,
        query,
        usedQuery: attemptedQueries[attemptedQueries.length - 1] || query,
        attemptedQueries,
        requestedLot,
        total: addresses.length,
        addresses,
        debug: {
          rawTotalCount: rawResponses.reduce(
            (sum, item) => sum + item.totalCount,
            0
          ),
          rawResponses,
        },
        message: addresses.length === 0
          ? "검색 결과가 없어. 주소를 확인해 줘."
          : undefined,
      });

    } catch (error) {
      console.log("ADDRESS SEARCH ERROR:", error?.message || String(error));
      return json({
        error: "주소 검색 중 오류 발생",
        detail: error?.message || String(error),
      }, 500);
    }
  },
};