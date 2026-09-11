import axios from "axios";

async function testLiveApi() {
    console.log("Calling live dev server: POST http://localhost:5000/api/push-campaigns/3/send ...");
    const res = await axios.post("http://localhost:5000/api/push-campaigns/3/send");
    console.log("Response:", res.data);
}

testLiveApi().catch(err => {
    console.error("API error:", err.response?.data || err.message);
});
