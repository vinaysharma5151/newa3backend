const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { CohereClient } = require('cohere-ai');
require('dotenv').config();

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
    }
});

app.use(express.json());
app.use(express.static('public'));

// Initialize Cohere
const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
});

// Store active debate rooms and polls
const debateRooms = new Map();
const polls = new Map();

// Function to query AI
async function queryAI(question) {
    try {
        console.log('Sending request to Cohere...');
        const response = await cohere.generate({
            model: 'command-nightly',
            prompt: `As a fact-checker, please verify or answer this: ${question}`,
            max_tokens: 150,
            temperature: 0.7
        });

        console.log('Cohere Response:', response);
        return response.generations[0].text;
    } catch (error) {
        console.error('Error querying Cohere:', error.message);
        return 'Error processing the fact check request. Please try again later.';
    }
}

io.on('connection', (socket) => {
    console.log('A user connected');

    // Handle voice recordings
    socket.on('sendVoiceMessage', (data) => {
        console.log('Voice message received from:', data.username);
        socket.to(data.topic).emit('receiveVoiceMessage', {
            audioUrl: data.audioUrl,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    socket.on('joinDebate', (debateTopic) => {
        console.log(`User joined debate: ${debateTopic}`);
        socket.join(debateTopic);
        if (!debateRooms.has(debateTopic)) {
            debateRooms.set(debateTopic, new Set());
        }
        debateRooms.get(debateTopic).add(socket.id);
    });

    socket.on('sendMessage', (data) => {
        console.log('Message received:', data);
        let pollId = null;
        
        if (data.isQuestion || data.isAnswer) {
            pollId = `poll-${Date.now()}`;
            polls.set(pollId, {
                text: data.text,
                type: data.isQuestion ? 'question' : 'answer',
                votes: {
                    valid: 0,
                    invalid: 0
                },
                voters: new Set(),
                author: data.username
            });
        }

        io.to(data.topic).emit('receiveMessage', {
            text: data.text,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString(),
            isQuestion: data.isQuestion,
            isAnswer: data.isAnswer,
            pollId: pollId
        });
    });

    socket.on('votePoll', (data) => {
        const poll = polls.get(data.pollId);
        if (poll && !poll.voters.has(data.username)) {
            poll.votes[data.vote]++;
            poll.voters.add(data.username);
            
            io.to(data.topic).emit('pollUpdate', {
                pollId: data.pollId,
                votes: poll.votes,
                totalVotes: poll.votes.valid + poll.votes.invalid
            });
        }
    });

    socket.on('checkFact', async (data) => {
        console.log('Fact check requested:', data.text);
        try {
            const response = await queryAI(data.text);
            
            socket.emit('factCheckResult', {
                original: data.text,
                result: response,
                timestamp: new Date().toLocaleTimeString()
            });
        } catch (error) {
            console.error('Error in checkFact handler:', error);
            socket.emit('factCheckResult', {
                original: data.text,
                result: 'Sorry, there was an error processing your request.',
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        debateRooms.forEach((users, topic) => {
            if (users.has(socket.id)) {
                users.delete(socket.id);
                if (users.size === 0) {
                    debateRooms.delete(topic);
                }
            }
        });
    });
});

// Add this near the top of server.js, after the imports
const DEBATE_TOPICS = {
    Technology: [
        { id: "tech1", name: "Artificial Intelligence Ethics" },
        { id: "tech2", name: "Cybersecurity vs Privacy" },
        { id: "tech3", name: "Social Media Regulation" },
        { id: "tech4", name: "Automation and Employment" }
    ],
    Environment: [
        { id: "env1", name: "Climate Change Solutions" },
        { id: "env2", name: "Renewable Energy" },
        { id: "env3", name: "Wildlife Conservation" },
        { id: "env4", name: "Sustainable Cities" }
    ],
    Society: [
        { id: "soc1", name: "Universal Basic Income" },
        { id: "soc2", name: "Education Reform" },
        { id: "soc3", name: "Healthcare Systems" },
        { id: "soc4", name: "Immigration Policy" }
    ],
    Politics: [
        { id: "pol1", name: "Electoral System Reform" },
        { id: "pol2", name: "Global Governance" },
        { id: "pol3", name: "Freedom of Speech" },
        { id: "pol4", name: "Media Regulation" }
    ]
};

// Fact checking endpoint using a simpler approach with free model
app.post('/api/fact-check', async (req, res) => {
    try {
        const { statement, topic } = req.body;

        // Using HuggingFace's free inference API
        const response = await fetch(
            "https://api-inference.huggingface.co/models/facebook/bart-large-mnli",
            {
                headers: {
                    "Authorization": "Bearer hf_abcd1234..." // Replace with your actual token
                },
                method: "POST",
                body: JSON.stringify({
                    inputs: statement,
                    parameters: {
                        candidate_labels: ["true", "false", "uncertain"]
                    }
                }),
            }
        );

        const result = await response.json();

        // Process the result
        const isFactual = result.labels[0] === "true";
        let explanation = "Based on analysis of the statement";
        
        // Create a more detailed explanation based on the confidence scores
        if (result.scores[0] > 0.7) {
            explanation += " with high confidence";
        } else if (result.scores[0] > 0.5) {
            explanation += " with moderate confidence";
        } else {
            explanation += " with low confidence";
        }

        const factCheckResult = {
            isFactual: isFactual,
            explanation: explanation,
            sources: "Analysis performed using natural language processing"
        };

        res.json(factCheckResult);

    } catch (error) {
        console.error('Error details:', error);
        res.status(500).json({ 
            error: 'Error checking fact', 
            details: error.message
        });
    }
});

// Add this new endpoint before app.listen()
app.get('/api/topics', (req, res) => {
    res.json(DEBATE_TOPICS);
});

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 