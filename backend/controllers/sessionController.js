import asynchHandler from 'express-async-handler';
import Session from '../models/SessionModel.js';
import fetch from 'node-fetch';
import fs from "fs";
import FormData from "form-data";
import path from "path";
import mongoose from "mongoose";

const AI_SERVICE_URL = "http://localhost:8000";

const pushSocketUpdate = (io, userID, sessionID, status, message, sessionData=null) => {
    io.to(userID.toString()).emit("sessionUpdate", {
        sessionID,
        status,
        message,
        sessionData
    });
}   

const createSession = asyncHandler(async (req, res) => {
    const {role, level, interviewType, count} = req.body;
    const userId=req.user._id;

    if(!role || !level || !interviewType || !count){
        res.status(400);
        throw new Error("Please fill all the fields");
    }
    let session = await Session.create({
        user:userId,
        role,
        level,
        interviewType,
        status: "pending",
    })

    const io=req.app.get("io")

    res.status(202).json({
        message: "Session created successfully",
        sessionID: session._id,
        status: "processing"
    })

    //IIFE- Immediately Invoked Function Expression
    (async () => {
        try {
            pushSocketUpdate(io, userId, session._id, "ai generating questions...", `generating ${count} questions for ${level} level ${role} role interview...`);
            const aiResponse = await fetch(`${AI_SERVICE_URL}/generate-questions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ role, level, count,  interview_type: interviewType})
            });

            if (!aiResponse.ok) {
                const errorBody = await aiResponse.text();
                throw new Error(`ai service error : ${aiResponse.status} - ${errorBody}`);
            }
            const aiData = await aiResponse.json();
            const codingCount = interviewType === "coding-mix" ? Math.floor(count*0.2) : 0;

            const questionsArray = aiData.questions.map((qText, index) => ({
                questionText: qText,
                questionType: index < codingCount ? "coding" : "oral",
                isEvaluated: false,
                isSubmitted: false
            }));

            session.questions = questionsArray;
            session.status = "in-progress";
            await session.save();

            pushSocketUpdate(io, userId, session._id, "questions ready", "starting interview... ");

        } catch (error) {
            console.error('Session creation failed: ${error.message}');
            session.status = "failed";
            await session.save();
            pushSocketUpdate(io, userId, session._id, "failed", error.message);
        }
})();

});

const getSessions = asyncHandler(async (req, res) => {

    const sessions = await Session.find({ user: req.user._id }).sort({ createdAt: -1 }).select('-questions.userAnswerText -questions.userSubmittedCode'); 
    res.json(sessions);
});

const getSessionById=asyncHandler(async (req, res) => {
    const userId=req.user._id;
    const sessionId=req.params.id;
    const session=await Session.findOne({user:userId, _id:sessionId});
    if(!session){
        res.status(404);
        throw new Error("Session not found");
    }
    res.status(200).json(session);
});

const deleteSession=asyncHandler(async (req, res) => {
    const sessionId=req.params.id;
    const session=await Session.findById(sessionId);
    if(!session){
        res.status(404);
        throw new Error("Session not found");
    }   
    if(session.user.toString() !== req.user._id.toString()){
        res.status(401);
        throw new Error("Not authorized to delete this session");
    }

    await session.deleteOne();
    res.status(200).json({id:sessionId, message:"Session deleted successfully"});
});

const calculateOverallScore = async (sessionId) => {
    const results = await Session.aggregate([
        { $match: { _id: new mongoose.Types.ObjectId(sessionId) } },
        { $unwind: '$questions' },
        
        {
            $group: {
                _id: '$_id',
          
                avgTechnical: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.technicalScore', 0] }
                },
                avgConfidence: {
                    $avg: { $cond: [{ $eq: ['$questions.isEvaluated', true] }, '$questions.confidenceScore', 0] }
                }
            }
        },
        {
            $project: {
                _id: 0,
                
                overallScore: { $round: [{ $avg: ['$avgTechnical', '$avgConfidence'] }, 0] },
                avgTechnical: { $round: ['$avgTechnical', 0] },
                avgConfidence: { $round: ['$avgConfidence', 0] },
            }
        }
    ]);

    return results[0] || { overallScore: 0, avgTechnical: 0, avgConfidence: 0 };
};

const evaluateAnswerAsync=async(io, userId, sessionId, questionIdx, audioFilePath=null, codeSubmission=null) => {
    let transcription="";
    const questionIndex=typeof questionIdx==="string"?parseInt(questionIdx, 10):questionIdx;

    const session=await Session.findById(sessionId);

    if(!session){
        pushSocketUpdate(io,userId,sessionId,"failed","session not found");
        return;
    } 

    const question = session.questions[questionIdx];

    if(!question){
        pushSocketUpdate(io, userId, sessionId, "failed", "Question not found");
        return;
    }

    if(audioFilePath){
       try{
         pushSocketUpdate(io, userId, sessionId, 'AI_Transcribing..', `Transcribing audio for Q${questionIdx + 1}...`);
         const formData = new FormData();
         formData.append("file", fs.createReadStream(audioFilePath)); 

         const transResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
                method: 'POST',
                body: formData,
                headers: formData.getHeaders(),
            });

            if (!transResponse.ok) throw new Error('Transcription service failed');

            const transData = await transResponse.json();
            transcription=transData.transcription || "";
         
       }
       catch(error) {
        console.error(`Transcription Error: ${error.message}`);
       } finally {
         if (audioFilePath && fs.existsSync(audioFilePath)) fs.unlinkSync(audioFilePath);
       }
    }

    try{
       pushSocketUpdate(io, userId, sessionId, 'AI_EVALUATING', `AI is analyzing Q${questionIdx + 1}...`);
       
       const evalResponse = await fetch(`${AI_SERVICE_URL}/evaluate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: question.questionText,
                question_type: question.questionType, 
                role: session.role,
                level: session.level,
                user_answer: transcription,
                user_code: code || "",     
            }),
        });

        if (!evalResponse.ok) throw new Error('AI Evaluation service failed');

        const evalData = await evalResponse.json();
        question.isEvaluated()=true;

        question.userAnswerText=transcription;
        question.userSubmittedCode=code||"";
        question.idealAnswer=evalData.idealAnswer;
        question.aiFeedback=evalData.aiFeedback;
        question.technicalScore=evalData.technicalScore;
        question.confidenceScore=evalData.confidenceScore;
        question.isEvaluated=true;

        
        const allQuestionsEvaluated=session.questions.every(q=>q.isEvaluated);

        if(session.status==="completed" || allQuestionsEvaluated){
            const scoreSummary = await calculateOverallScore(sessionId);
            session.overallScore=scoreSummary.overallScore;
            session.metrics={
                avgTechnical:scoreSummary.avgTechnical,
                avgConfidence:scoreSummary.avgConfidence
            };

            if(allQuestionsEvaluated){
                session.status="completed";
                session.endTime=session.endTime || new Date();
            }

            await session.save();
             pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Scores finalized.', session);
        }
        else {
            await session.save();
            pushSocketUpdate(io, userId, sessionId, 'EVALUATION_COMPLETE', `Feedback for Q${questionIdx + 1} is ready!`, session);
        }
    }
    catch {
        console.error(`Evaluation Error: ${error.message}`);
        pushSocketUpdate(io, userId, sessionId, 'EVALUATION_FAILED', `Evaluation failed.`, session);
    }
}



const submitAnswer=asynchHandler(async(req,res)=>{
    const userId=req.user._id;
    const sessionId=req.params.id;
    const {questionIndex, code}=req.body;
    const session=await Session.findById(sessionId);
    if(!session || session.user.toString()!==userId.toString()){
        res.status(404);
        throw new Error("Session not found");
    }
    const questionIdx = parseInt(questionIndex, 10);
    const question = session.questions[questionIdx];

    if (!question) {
        res.status(400);
        throw new Error(`Question at index ${questionIdx} not found.`);
    }

    let audioFilePath=null;
    if(req.file){
        audioFilePath=path.join(process.cwd(), req.file.path);
    }

    const codeSubmission = code || null;

    question.isSubmitted=true;
    await session.save();

    res.status(202).json({
        message: 'Answer received. Processing asynchronously...',
        status: 'received',
    });
    
    const io = req.app.get('io');

    evaluateAnswerAsync(io, userId, sessionId, questionIdx, audioFilePath, codeSubmission);

})

const endSession = asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const userId = req.user._id;

    const session = await Session.findById(sessionId);

    if (!session || session.user.toString() !== userId.toString()) {
        res.status(404);
        throw new Error('Session not found or user unauthorized.');
    }
    const isProcessing = session.questions.some(q => q.isSubmitted && !q.isEvaluated);
    if (isProcessing) {
        res.status(400);
        throw new Error('Cannot end interview while AI is processing answers.');
    }
    if (session.status === 'completed') {
        res.status(400);
        throw new Error('Session is already completed.');
    }

  
    const scoreSummary = await calculateOverallScore(sessionId);

    session.overallScore = scoreSummary.overallScore || 0;
    session.status = 'completed';
    session.endTime = new Date();
    session.metrics = {
        avgTechnical: scoreSummary.avgTechnical,
        avgConfidence: scoreSummary.avgConfidence,
    };

    await session.save();

    const io = req.app.get('io');
    pushSocketUpdate(io, userId, sessionId, 'SESSION_COMPLETED', 'Interview session ended early.', session);

    res.json({ message: 'Session ended successfully.', session });
});

export { createSession, getSessions, getSessionById, deleteSession, calculateOverallScore, submitAnswer, endSession };


