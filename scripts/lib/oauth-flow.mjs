/**
 * The one time Google authorization dance, shared by get-refresh-token.mjs
 * and setup.mjs. Spins up a loopback listener, opens the consent screen, and
 * trades the returned code for a refresh token. Nothing leaves the machine
 * except the calls to Google.
 */
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";

export const PORT = 8787;
export const REDIRECT = `http://localhost:${PORT}/callback`;
export const SCOPE = "https://www.googleapis.com/auth/tasks";

/** Prompt on stdin. `mask` hides typing, for secrets. */
export function ask(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (mask) {
      const onData = (char) => {
        if (["\n", "\r", "\u0004"].includes(char.toString())) process.stdin.removeListener("data", onData);
        else process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
      };
      process.stdin.on("data", onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function openBrowser(url) {
  // Not `cmd /c start`: cmd treats & as a command separator, so it would hand
  // the browser everything up to the first query parameter and drop the rest,
  // which Google rejects as a missing response_type. rundll32 takes the URL as
  // a single argument and does no parsing of its own.
  const [command, args] =
    process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the printed URL is the fallback */
  }
}

export function consentUrl(clientId) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/**
 * Resolves with the refresh token, or rejects with a readable reason.
 */
export function getRefreshToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const failure = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (failure || !code) {
        res.writeHead(400, { "content-type": "text/html" })
           .end(`<h1>Authorization failed</h1><p>${failure ?? "no code returned"}</p>`);
        server.close();
        reject(new Error(failure ?? "Google returned no authorization code."));
        return;
      }

      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: REDIRECT,
            grant_type: "authorization_code",
          }),
        });
        const payload = await response.json();

        if (!payload.refresh_token) {
          res.writeHead(400, { "content-type": "text/html" })
             .end("<h1>No refresh token</h1><p>Check the terminal.</p>");
          server.close();
          reject(new Error(
            `Google returned no refresh token (${payload.error_description ?? payload.error ?? "unknown"}). ` +
            "If you have authorized this client before, revoke it at " +
            "https://myaccount.google.com/permissions and run this again.",
          ));
          return;
        }

        res.writeHead(200, { "content-type": "text/html" }).end(
          "<h1>Done</h1><p>Back to the terminal. You can close this tab.</p>",
        );
        server.close();
        resolve(payload.refresh_token);
      } catch (error) {
        res.writeHead(500).end("Exchange failed");
        server.close();
        reject(error);
      }
    });

    server.on("error", (error) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${PORT} is busy. Close whatever is using it and try again.`)
          : error,
      );
    });

    server.listen(PORT, () => {
      const url = consentUrl(clientId);
      console.log(`\nListening on ${REDIRECT}`);
      console.log("Opening your browser. If nothing happens, paste this in:\n");
      console.log(url + "\n");
      console.log('Google will warn that the app is not verified. Choose "Advanced",');
      console.log('then "Go to <your app> (unsafe)". It is your own app.\n');
      openBrowser(url);
    });
  });
}
