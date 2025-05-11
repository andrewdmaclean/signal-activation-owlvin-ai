import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';
import twilio from 'twilio';
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
// import serviceAccount from "./service-account-key.json" assert {type: "json"}; // local
import serviceAccount from "/etc/secrets/service-account-key.json" with {type: "json"}; // deployment

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // database URL
});

const db = admin.database(); // Get a database reference
////////////////////////////////

function hashPhoneNumber(number) {
  const salt = 'apples_are_not_yellow';
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

async function generatePrompt (msg){
  /**
       * Hash the incoming phone number to grab personality and topic from firebase.
       * Since threads are not used, history is not stored in threads and no assistants are used.
       */
  const userId = hashPhoneNumber(msg.from);
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef)
    data = result.val();
    console.log("here's the data from friebase: ", data)
  } catch (err) {
    console.error("error connecting to firebase: ", err)
  }

  const topic = data.topic;
  const personality = data.personality;

  const prompt = `You are a chat bot who will discuss ${topic} with the caller. 
Never include punctuation or exclamation marks in your responses. 
You have a very strong ${personality} personality and you incorporate that personality in each response. 
Keep responses short, no more than 15 words, and always end each response with a question. 
Feel free to discuss anything discussed previously in the chat.`

return prompt;
  ////////////////////////////////////////////////////////////////////////////////////////////////////
}

app.ws('/connection', async (ws) => {
  // The following code uses OpenAI streaming
  try {
    ws.on('message', async (data) => {
      const msg = JSON.parse(data);
      console.log("Incoming message:", msg);

      // Set phone number in ws var
      if (msg.from) {
        connections.set(ws, msg.from);
      }

      /**
       * Create a conversation thread. Include the prompt for instruction and first user message so agent
       * so it feels like the agent is starting a conversation with the user.
       */

      const history = [];
      ////////////////////////////////////////////////////////////////////////////////////////////////////

      if (msg.type === "setup") {
        let prompt = await generatePrompt(msg);
        console.log(prompt)

        messageHistories.set(ws, history); // ws Map

        history.push(
          {
            role: "system", content: prompt
          },
          { role: "user", content: "Hi there!" }
        )

        console.log("history, line 102: ", history);

        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-nano",
          messages: history,
          stream: false
        });

        const assistantMessage = completion.choices[0]?.message.content;
        console.log("[setup] here's the completion data: ", assistantMessage)
        history.push(assistantMessage);
        console.log("here's the history: ", history)

        ws.send(JSON.stringify({
          type: "text",
          token: assistantMessage
        }));

      } else if (msg.type === "prompt") {

        try {
          history.push({
            role: 'user',
            content: JSON.stringify(msg.voicePrompt),
          });

          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-nano",
            messages: history,
            stream: false
          });

          const assistantMessage = completion.choices[0]?.message.content;
          history.push(assistantMessage);
          
          console.log("[prompt] here's the completion data: ", assistantMessage)
          
          ws.send(JSON.stringify({
            type: "text",
            token: assistantMessage
          }));

        } catch (err) {
          console.error("Run failed:", err);
        }
      }
    });
    ws.on("close", async () => {
      const caller = connections.get(ws);
      console.log("here's the caller data: ", caller)
      ////////////////// Send Text Message ////////////////////
      try {
        await client.messages.create({
          from: process.env.FROM_NUMBER,
          to: caller,
          body: `Dear creator, feel free to call me back anytime!\n(415)704-6756`
        }).then(s => {
          console.log('message sent');
        });
      } catch (error) {
        console.error('ERROR!!!!!!!', error);
      }
      //////////////////////////////////////////////////////////
      connections.delete(ws)
      console.log("WebSocket connection closed");
    });
  } catch (err) {
    console.log(err);
  }
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});