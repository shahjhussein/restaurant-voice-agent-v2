import express from "express";
import dotenv from "dotenv";

import WebSocket from "ws";

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

    // Initial session config
    openAiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "You are a friendly restaurant AI assistant.",
        modalities: ["audio", "text"],
        voice: "alloy"   // default OpenAI voice
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


dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Restaurant AI Voice Agent - Server Running on Render");
});

import { WebSocketServer } from "ws";
import http from "http";

// Create HTTP server so WS can attach to it
const server = http.createServer(app);

// WebSocket server for Twilio Media Streams
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Twilio media stream connected");

  // Connect to OpenAI for this call
  const openAiWs = connectToOpenAI();

  openAiWs.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  // OpenAI will send audio chunks in streaming events
  if (msg.type === "response.audio.delta") {
    const audioChunk = msg.delta; // base64 PCM audio

    // Send audio back to Twilio
    ws.send(JSON.stringify({
      event: "media",
      media: {
        payload: audioChunk
      }
    }));
  }
});


  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log("🟢 Media stream started:", data.streamSid);
    }

    if (data.event === "media") {
      // Send caller audio to OpenAI
      openAiWs.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: data.media.payload  // base64 mulaw audio

      // Tell OpenAI to process the audio chunk
      openAiWs.send(JSON.stringify({
      type: "input_audio_buffer.commit"
      }));

      openAiWs.send(JSON.stringify({
      type: "response.create"
      }));

}));

    }

    if (data.event === "stop") {
      console.log("🔴 Media stream stopped:", data.streamSid);
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WS connection closed");
  });
});


const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Server listening on port", port);
});


import twilio from "twilio";

// Twilio Voice Webhook
app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com/twilio-media-stream"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});


