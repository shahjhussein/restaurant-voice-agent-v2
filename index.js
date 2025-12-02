import express from "express";
import dotenv from "dotenv";

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

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "start") {
      console.log("🟢 Media stream started:", data.streamSid);
    }

    if (data.event === "media") {
      // Base64-encoded mulaw audio from caller
      console.log("🎤 Received audio chunk:", data.media.payload.length);
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


