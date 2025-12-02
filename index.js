import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

// ----------------------------------------------------
//  OPENAI REALTIME CONNECTION
// ----------------------------------------------------
function connectToOpenAI() {
  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openAiWs.on("open", () => {
    console.log("🧠 Connected to OpenAI Realtime");

    openAiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "You are a friendly restaurant AI assistant.",
        modalities: ["audio"],
        voice: "alloy"
      }
    }));
  });

  openAiWs.on("close", () => {
    console.log("⭕ OpenAI WebSocket closed");
  });

  openAiWs.on("error", (err) => {
    console.error("❌ OpenAI WebSocket error:", err);
  });

  return openAiWs;
}

// ----------------------------------------------------
//  EXPRESS APP
// ----------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Restaurant AI Voice Agent - Server Running on Render");
});

// ----------------------------------------------------
//  CREATE HTTP SERVER + WEBSOCKET SERVER
// ----------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ----------------------------------------------------
//  HANDLE TWILIO MEDIA STREAM CONNECTION
// ----------------------------------------------------
wss.on("connection", (ws) => {
  console.log("🔌 Twilio media stream connected");

  // Create OpenAI session for this call
  const openAiWs = connectToOpenAI();

  // ----------------------------
  //  HANDLE OPENAI → TWILIO AUDIO
  // ----------------------------
  openAiWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "response.audio.delta") {
      const audioChunk = msg.delta; // base64 PCM

      ws.send(JSON.stringify({
        event: "media",
        media: { payload: audioChunk }
      }));
    }
  });

  // ----------------------------
  //  HANDLE TWILIO → OPENAI AUDIO
  // ----------------------------
  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log("🟢 Media stream started:", data.streamSid);
    }

    if (data.event === "media") {
      // Append caller audio chunk
      openAiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));

      // Tell OpenAI to process what we've received
      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    }

    if (data.event === "stop") {
      console.log("🔴 Media stream stopped:", data.streamSid);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS connection closed");
  });
});

// ----------------------------------------------------
//  TWILIO VOICE WEBHOOK
// ----------------------------------------------------
app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com/twilio-media-stream"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ----------------------------------------------------
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Server listening on port", port);
});
