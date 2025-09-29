// Centralized prompt text for OpenAI calls.
const MONITORING_SYSTEM_PROMPT = 'You evaluate screenshots captured while a blocked site is temporarily unblocked. Compare the screenshot with the stated task. If the screenshot does not clearly match the task or is ambiguous, mark compliant as false and explain why. Keep reasons concise.';

const REVIEW_SYSTEM_PROMPT = 'You review requests for temporary access to blocked websites. Approve only when the request aligns with the global policy and the site-specific policy for the host. Deny otherwise, citing the most relevant policy in your reasoning. Keep reasons concise.';

function createReviewPrompt({ host, purpose, durationMinutes, sitePolicy, globalPolicy, blockedHosts }) {
  const sitePolicyText = sitePolicy ? sitePolicy : 'No site-specific policy recorded.';
  const blockedList = blockedHosts.length ? blockedHosts.join(', ') : 'None';
  const now = new Date();
  let requestTimestamp = now.toISOString();

  try {
    requestTimestamp = now.toLocaleString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
  } catch (_error) {
    // Fall back to ISO string if locale formatting fails.
  }

  return `Global policy:\n${globalPolicy || 'No global policy defined.'}\n\nSite policy for ${host}:\n${sitePolicyText}\n\nBlocked hosts:\n${blockedList}\n\nAccess request details:\n- Host: ${host}\n- Purpose: ${purpose}\n- Requested minutes: ${durationMinutes}\n- Request time: ${requestTimestamp}`;
}
