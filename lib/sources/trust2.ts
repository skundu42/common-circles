// Source 1 — Second-degree Circles trust ("Friends of friends"). All client-side
// via @/lib/circles (getTrustMap wraps getAggregatedTrustRelations); no new
// route, no new key. Seed = connected Circles avatar address (lowercased).

import { getTrustMap } from "@/lib/circles";
import { mapLimit } from "@/lib/util";
import type { DiscoverySource, SourceResult, Candidate } from "@/lib/sources/types";

/** Cap first-degree contacts we fan out from, to bound RPC. Mutuals chosen first. */
export const TRUST2_CONTACT_CAP = 150;
/** Bounded concurrency for the per-contact getTrustMap fan-out. */
const TRUST2_FANOUT = 8;
/** Cap the second-degree candidate set we verify on-chain, ranked by vouch
 *  count. A hub user's 150 contacts can trust thousands of distinct people;
 *  verifying all of them is a slow RPC storm for diminishing (weight-1) signal. */
export const TRUST2_CANDIDATE_CAP = 400;

export const trust2Source: DiscoverySource = {
  id: "trust2",
  label: "Friends of friends",
  evidenceNoun: "trusted contacts",
  needsHandle: false,
  async discover(seed, signal): Promise<SourceResult> {
    const self = seed.toLowerCase();

    // 1. first-degree circle (relation keyed by lowercase counterparty).
    const first = await getTrustMap(self);

    // 2. contacts I trust OUTWARD (vouchers): relation ∈ {trusts, mutuallyTrusts}.
    //    "trustedBy" = they trust me, not a voucher → excluded.
    //    Mutuals first (strongest), then plain "trusts", then cap.
    const mutuals = [...first].filter(([, r]) => r === "mutuallyTrusts").map(([a]) => a);
    const outward = [...first].filter(([, r]) => r === "trusts").map(([a]) => a);
    const contacts = [...mutuals, ...outward].slice(0, TRUST2_CONTACT_CAP);
    const contactsTruncated = mutuals.length + outward.length > TRUST2_CONTACT_CAP;

    // 3. fan out: each contact's outward trusts. Bounded concurrency 8.
    const firstDegree = new Set(first.keys()); // for step-4 exclusion
    let contactsFailed = 0; // contacts whose circle couldn't be read (RPC error)
    const perContact = await mapLimit(contacts, TRUST2_FANOUT, async (contact) => {
      if (signal?.aborted) return [] as string[];
      try {
        const m = await getTrustMap(contact);
        return [...m]
          .filter(([, r]) => r === "trusts" || r === "mutuallyTrusts")
          .map(([a]) => a); // people my contact trusts outward
      } catch {
        contactsFailed++; // degrade per contact, never throw — but count it
        return [] as string[];
      }
    });

    // 4. tally per candidate, excluding seed + everyone already first-degree.
    const tally = new Map<string, number>();
    for (const list of perContact) {
      for (const addr of list) {
        if (addr === self || firstDegree.has(addr)) continue;
        tally.set(addr, (tally.get(addr) ?? 0) + 1);
      }
    }

    // 5. rank by vouch count (strongest second-degree edges first) and cap, so
    //    the matcher's on-chain verification has a predictable ceiling no matter
    //    how connected the seed is. NOT preVerified (edges can point to
    //    groups/orgs; the matcher's findCirclesAvatars filters to v2 humans).
    const ranked = [...tally].sort((a, b) => b[1] - a[1]);
    const candidatesTruncated = ranked.length > TRUST2_CANDIDATE_CAP;
    const candidates: Candidate[] = ranked
      .slice(0, TRUST2_CANDIDATE_CAP)
      .map(([address, count]) => ({
        address,
        weight: count,
        evidence: `Trusted by ${count} of your contacts`,
        preVerified: false,
      }));

    // 6. stats for the meta row.
    const stats: Record<string, number> = {
      contacts: contacts.length,
      candidates: tally.size,
    };
    if (contactsFailed > 0) stats.contactsFailed = contactsFailed;

    return {
      sourceId: "trust2",
      candidates,
      stats,
      truncated: contactsTruncated || candidatesTruncated,
    };
  },
};
