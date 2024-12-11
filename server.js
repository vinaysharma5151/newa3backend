const express = require('express');
const app = express();
app.use(express.json());
const http = require('http').createServer(app);
const { CohereClient } = require('cohere-ai');
require('dotenv').config();
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const path = require('path');
const cors = require('cors');

app.use(express.static('public'));

// Store active debate rooms
const debateRooms = new Map();
const polls = new Map(); // Store active polls

// Initialize Cohere
const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
});

// Function to query AI
async function queryAI(question) {
    try {
        console.log('Sending request to Cohere...');
        const response = await cohere.generate({
            model: 'command-nightly',
            prompt: `As a fact-checker, please verify or answer this: ${question}`,
            max_tokens: 150,
            temperature: 0.7,
            k: 0,
            stop_sequences: [],
            return_likelihoods: 'NONE'
        });

        console.log('Cohere Response:', response);
        return response.generations[0].text;
    } catch (error) {
        console.error('Error querying Cohere:', error.message);
        return 'Error processing the fact check request. Please try again later.';
    }
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Update CORS configuration
app.use(cors({
    origin: ['https://yourusername.github.io', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
}));

io.on('connection', (socket) => {
    console.log('A user connected');

    // Join debate room
    socket.on('joinDebate', (debateTopic) => {
        console.log(`User joined debate: ${debateTopic}`);
        socket.join(debateTopic);
        if (!debateRooms.has(debateTopic)) {
            debateRooms.set(debateTopic, new Set());
        }
        debateRooms.get(debateTopic).add(socket.id);
    });

    // Handle text messages
    socket.on('sendMessage', (data) => {
        console.log('Message received:', data);
        let pollId = null;
        
        // Create poll if message is a question or answer
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

    // Handle voice recordings
    socket.on('sendVoiceMessage', (data) => {
        io.to(data.topic).emit('receiveVoiceMessage', {
            audioUrl: data.audioUrl,
            team: data.team,
            username: data.username,
            timestamp: new Date().toLocaleTimeString()
        });
    });

    // Handle poll votes
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

    // Handle fact check requests
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
        // Remove user from debate rooms
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

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 