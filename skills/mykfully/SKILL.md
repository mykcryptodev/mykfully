---
name: mykfully
description: Draft X (Twitter) posts and threads in a mykfully instance, render previews of how they will look on X (mobile or desktop), check the credit balance, and buy credits with USDC over x402. Use when the user asks to write, draft, edit or preview a tweet or thread for X, or to check or top up mykfully credits.
---

# mykfully

mykfully is a self-hosted thread composer for X. Its MCP server lets you draft threads for the user, preview them as they will appear on X, and manage credits. **You can only draft.** Scheduling, publishing and deleting happen in the mykfully app, where the user reviews your draft first. Never tell the user a post went out.

## Setup (once)

1. In the mykfully app, open the sidebar and choose **Connect an agent**, then **Create token**. Copy the `myk_…` token; it is shown once.
2. Add the MCP server. The URL is the instance's address plus `/api/mcp`.

   Claude Code:

   ```bash
   claude mcp add --transport http mykfully https://<your-mykfully-host>/api/mcp \
     --header "Authorization: Bearer $MYKFULLY_TOKEN"
   ```

   Other MCP clients (Streamable HTTP):

   ```json
   { "mcpServers": { "mykfully": { "type": "http", "url": "https://<your-mykfully-host>/api/mcp",
       "headers": { "Authorization": "Bearer <token>" } } } }
   ```

Keep the token secret: anyone holding it can draft as the user and spend USDC on their behalf through the purchase route. Revoke it in **Connect an agent** if it leaks.

## Tools

| Tool | Use it to |
|---|---|
| `get_account` | Get the account name, @username, `maxPostLength` (280, or 25,000 for Premium), the credit balance, costs, and the x402 purchase info. Call it first. |
| `create_draft` | Save a new single post or thread: `{ posts: [{ text }, …] }`. |
| `update_draft` | Replace a draft's posts (only drafts with status `draft`). Send the full ordered list, and keep each existing post's `id` to keep its media. |
| `get_draft` / `list_drafts` | Read drafts, including per-post `length`, `maxLength` and `fits`. |
| `preview_draft` | Get an image (PNG, or JPEG for photo-heavy threads) of the thread as it will look on X. Pass `draftId`, or pass `posts` for unsaved text. `device` is `mobile` (default) or `desktop`; `theme` is `light` or `dark`; `numbered` adds 1/N labels. Each image shows up to 8 posts, so page with `start` / `nextStart`. |
| `get_credits` | Get the balance and recent ledger entries. 1 credit ≈ $0.001 of X API spend. |
| `buy_credits` | Get the price and the exact x402 request for a credit pack. It does **not** pay. |

## Drafting workflow

1. Call `get_account` to learn `maxPostLength`.
2. Write the post(s):
   - Keep each post at or under `maxPostLength`. X counts every URL as 23 characters, and emoji and CJK characters as 2. Trust the server's `length` / `fits`, not your own count.
   - Split threads at sentence or idea boundaries, and make the first post stand on its own.
   - Don't add "1/" numbering to the text unless the user asks; `preview_draft` can show it with `numbered: true`.
3. Call `create_draft` (or `update_draft` while iterating). If any post has `fits: false`, shorten or split it and update.
4. Call `preview_draft` (mobile unless the user asks for desktop), look at the image, and fix anything that reads badly: awkward line breaks, walls of text, a weak opener. (Link cards aren't rendered; URLs show as shortened blue text.)
5. Give the user the draft `url` so they can attach media, schedule or publish it in the app.

Drafts never spend credits. Publishing does, in the app: about `costs.post` per post, and more with a URL.

## Buying credits (x402, USDC on Base)

Use this when `get_account` shows `purchase.enabled: true` and the user wants more credits.

1. Call `buy_credits` with the chosen `packId` (`get_account` → `purchase.packs`, e.g. `p1` = $1 = 1,000 credits).
2. **Confirm the price with the user before paying.**
3. Send the returned `request` with an x402-capable client, reusing the same API token in the `Authorization` header. For example, with the Base MCP server:

   ```
   initiate_x402_request {
     url: "<request.url>", method: "POST", maxPayment: "<priceUsdc>",
     headers: { "Authorization": "Bearer <token>", "Content-Type": "application/json" },
     body: { "packId": "<packId>" }
   }
   ```

   Then follow its approval or completion steps.
4. Before signing, check that the challenge pays exactly `payTo` in `asset` (USDC) on `network`, as `buy_credits` reported.
5. Read the result:
   - **200** `{ balance, credits, txHash }`: done.
   - **202** `{ pending: true }`: the payment was submitted but not yet confirmed. **Do not pay again.** Check `get_credits` later; the operator reconciles pending payments.
   - **402** with `code: payment_rejected`: nothing was charged. Read `reason`.

## Errors

Tool errors come back as `isError` results with `{ error, code }`. The common codes:

- `invalid_request`: fix the arguments using the `issues` list.
- `rate_limited`: wait `retryAfter` seconds.
- `error` + "Draft is scheduled and can't be edited": the user must change the draft in the app.
- `purchases_disabled`: this instance doesn't sell credits; ask the operator for a grant.
