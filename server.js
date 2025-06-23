import OpenAI from "openai";
import "dotenv/config";
import express from "express";
import ExpressWs from "express-ws";
import crypto from "crypto";
import twilio from "twilio";
const accountSid = process.env.TWILIO_ACCOUNT_SID_MESSAGING;
const authToken = process.env.TWILIO_AUTH_TOKEN_MESSAGING;
const client = twilio(accountSid, authToken);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);

const PORT = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const connections = new Map();
const messageHistories = new Map();

////// Firebase Stuff /////
import { ref, get } from "firebase/database";
import admin from "firebase-admin";

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();
////////////////////////////////

function extractPhoneInfo(rawNumber) {
  let isWhatsapp = false;
  let number = rawNumber;
  if (number && number.startsWith("whatsapp:")) {
    isWhatsapp = true;
    number = number.replace("whatsapp:", "");
  }
  return { number, isWhatsapp };
}

function hashPhoneNumber(number) {
  const salt = "apples_are_not_yellow";
  return crypto
    .createHash("sha256")
    .update(number + salt)
    .digest("hex");
}

async function generatePrompt(msg) {
  const { number: cleanNumber, isWhatsapp } = extractPhoneInfo(msg.from);
  const userId = hashPhoneNumber(cleanNumber);
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef);
    data = result.val();
  } catch (err) {
    console.error("error connecting to firebase: ", err);
  }

  const { topic, personality, locale } = data || {};
  const languageInstruction =
    locale === "pt"
      ? "IMPORTANT: Always respond only in Brazilian Portuguese"
      : "IMPORTANT: Always respond only in English";

  return `
${languageInstruction}
IMPORTANT: Your response must be 15 words or less no punctuation always end with a question
You are a chat bot who will discuss ${topic} with the caller
You have a very strong ${personality} personality and you incorporate that personality in each response
Never include punctuation or exclamation marks in your responses
Keep responses short no more than 15 words and always end each response with a question
If you cannot answer in 15 words or less say I can only answer in 15 words or less Please rephrase
Feel free to discuss anything discussed previously in the chat`.trim();
}

app.ws("/connection", (ws) => {
  ws.on("message", async (data) => {
    const msg = JSON.parse(data);
    let history = messageHistories.get(ws) || [];
    messageHistories.set(ws, history);

    if (msg.from) {
      const { number, isWhatsapp } = extractPhoneInfo(msg.from);
      connections.set(ws, { number, isWhatsapp });
    }

    if (msg.type === "setup") {
      const prompt = await generatePrompt(msg);
      history.push(
        { role: "system", content: prompt },
        { role: "user", content: "Hi there!" }
      );

      // ↓ DROP the extra await when using v4 client
      const completion = openai.chat.completions.create({
        model: "gpt-4.1-nano",
        messages: history,
        stream: true,
      });

      let assistantMessage = "";
      for await (const chunk of completion) {
        const content = chunk.choices[0]?.delta?.content || "";
        const isLast = chunk.choices[0]?.finish_reason !== null;
        if (content) {
          assistantMessage += content;
          ws.send(JSON.stringify({ type: "text", token: content, last: isLast }));
        } else if (isLast) {
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));
        }
      }

      history.push({ role: "assistant", content: assistantMessage });
    } else if (msg.type === "prompt") {
      history.push({ role: "user", content: JSON.stringify(msg.voicePrompt) });

      // ↓ DROP the extra await here too
      const completion = openai.chat.completions.create({
        model: "gpt-4.1-nano",
        messages: history,
        stream: true,
      });

      let assistantMessage = "";
      for await (const chunk of completion) {
        const content = chunk.choices[0]?.delta?.content || "";
        const isLast = chunk.choices[0]?.finish_reason !== null;
        if (content) {
          assistantMessage += content;
          ws.send(JSON.stringify({ type: "text", token: content, last: isLast }));
        } else if (isLast) {
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));
        }
      }

      history.push({ role: "assistant", content: assistantMessage });
    }
  });

  ws.on("close", async () => {
    const callerInfo = connections.get(ws) || {};
    let toNumber = callerInfo.number;
    let fromNumber = process.env.FROM_NUMBER;

    const userId = hashPhoneNumber(toNumber);
    let data;
    try {
      const userRef = ref(db, `users/${userId}/profile`);
      const result = await get(userRef);
      data = result.val();
    } catch (err) {
      console.error("error connecting to firebase on close: ", err);
    }

    const locale = (data && data.locale) || "en";
    const closingBody =
      locale === "pt"
        ? "Caro criador sinta-se à vontade para me ligar de volta a qualquer momento"
        : "Dear creator feel free to call me back anytime";

    if (callerInfo.isWhatsapp) {
      toNumber = `whatsapp:${toNumber}`;
      fromNumber = `whatsapp:${fromNumber}`;
    }

    try {
      await client.messages.create({
        from: fromNumber,
        to: toNumber,
        body: closingBody,
      });
    } catch (error) {
      console.error("Error sending closing message:", error);
    }

    connections.delete(ws);
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
