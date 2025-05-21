const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https')
const querystring = require('querystring')
const url = require('url')

const port = 8080;

const {
    client_id,
    client_secret,
    refresh_token,
    code_verifier,
    code_challenge,
    response_type,
} = require("./auth/credentials-anime.json")

const server = http.createServer();

let num = null
let access_token = null

server.on("listening", () => console.log(`Listening on port ${port}`))
server.listen(port);

server.on("request", function(req, res) {
    console.log(`New connection created on: ${req.socket.remoteAddress}\nRequesting: ${req.url}`)

    if(req.url === "/"){
        const form = fs.createReadStream("html/index.html")
        res.writeHead(200, {"Content-Type": "text/html"})
        form.pipe(res)
    }else if(req.url === "/images/banner.jpg"){
        const banner = fs.createReadStream('images/banner.jpg')
        res.writeHead(200, {'Content-Type': 'image/jpeg'})
        banner.pipe(res)
    }
    else if(req.url.startsWith('/search-result')){
        makeAnimeCall(req, res)
    }
    else if(req.url.startsWith("/search")){
        const url_object = new URL(req.url, `http://${req.headers.host}`)
        num = parseInt(url_object.searchParams.get("number"))
        if(Number.isInteger(num) && num >= 2 && num <= 100){
            redirect_to_anime_list(num, req, res)
        }else{
            res.writeHead(302, { Location: "/" });
            res.end();
        }
    }
    else if(req.url.startsWith("/callback")){
        const query = url.parse(req.url, true).query;
        const { code } = query;

        const post_data = querystring.stringify({
            grant_type: "authorization_code",
            client_id,
            client_secret,
            code,
            code_verifier, // same as code_challenge when using 'plain'
            redirect_uri: "http://localhost:8080/callback"
        });

        const options = {
            hostname: 'myanimelist.net',
            path: '/v1/oauth2/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(post_data)
            }
        };

        const token_req = https.request(options, (token_res) => {
            let body = "";
            token_res.on("data", chunk => body += chunk);
            token_res.on("end", () => {

                //cache
                const tokenData = JSON.parse(body);
                access_token = tokenData.access_token;

                const expiration = new Date()
	            expiration.setSeconds(expiration.getSeconds() + tokenData.expires_in)
                tokenData.expiration = expiration

                const outPath = 'cache/auth.json';
                const auth = JSON.stringify(tokenData, null, 2)
                fs.writeFileSync(outPath, auth, err => {
                    if (err) console.log(err)
                })

                res.writeHead(302, { Location: "/search-result" });
                res.end();
            });
        });

        token_req.on("error", (err) => {
            console.error("Token request error:", err);
            res.writeHead(500, {"Content-Type": "text/plain"});
            res.end("Failed to retrieve access token.");
        });
    
        token_req.write(post_data);
        token_req.end();
    }
    else{
        res.writeHead(404, {"Content-Type": "text/plain"})
        res.end("404 Not Found")
    }
})

function redirect_to_anime_list(num, req, res) {
    const cachePath = path.join(__dirname, 'cache', 'auth.json');
    let cacheValid = false;
  
    if (fs.existsSync(cachePath)) {
      try {
        // read & parse raw JSON each time (avoids require-caching)
        const raw = fs.readFileSync(cachePath, 'utf8');
        const cachedAuth = JSON.parse(raw);
  
        // make sure it’s actually populated
        if (cachedAuth && Object.keys(cachedAuth).length) {
          const expiresAt = new Date(cachedAuth.expiration);
          if (expiresAt > new Date()) {
            // still fresh!
            access_token = cachedAuth.access_token;
            cacheValid = true;
          } else {
            // expired → delete cache so we force re-auth
            fs.unlinkSync(cachePath);
          }
        } else {
          // empty JSON → delete and re-auth
          fs.unlinkSync(cachePath);
        }
      } catch (err) {
        // on any read/parse error, clear bad cache
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      }
    }
  
    if (cacheValid) {
      // we have a valid token → go straight to search-result
      res.writeHead(302, { Location: '/search-result' });
      return res.end();
    }
  
    // otherwise, kick off MAL OAuth
    const authorization_endpoint = 'https://myanimelist.net/v1/oauth2/authorize';
    const queryParams = querystring.stringify({
      response_type: 'code',
      client_id,
      redirect_uri: 'http://localhost:8080/callback', // must exactly match your app settings
      code_challenge: code_challenge,                // plain → same as code_verifier
      code_challenge_method: 'plain',
    });
  
    const redirectUrl = `${authorization_endpoint}?${queryParams}`;
    res.writeHead(302, { Location: redirectUrl });
    res.end();
  }

function makeAnimeCall(req, res) {
    const options = {
        hostname: 'api.myanimelist.net',
        path: `/v2/anime/suggestions?limit=${num}`,
        method: 'GET',
        headers: {
            "Authorization": `Bearer ${access_token}`,
            "Accept": "application/json"
        }
    };

    const list_req = https.request(options, (list_res) => {
        let body = "";
        list_res.on("data", chunk => body += chunk);
        list_res.on("end", () => {
            try {
                let index = Math.floor(Math.random() * num);

                const animeJSON = JSON.parse(body);
                let anime = animeJSON.data[index].node
                makeGroqCall(anime, req, res)
            } catch (e) {
                console.error("JSON parse error:", e);
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Failed to parse anime list.");
            }
        });
    });

    list_req.on("error", (err) => {
        console.error("Request error:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to retrieve anime list.");
    });

    list_req.end();
}

function makeGroqCall(anime, req, res){
    const picture = anime.main_picture.large
    const title = anime.title

    const creds = require("./auth/credentials_groq.json")
    const groq_auth_token = creds['groq-auth-token']

    const post_data = {
        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
        "messages": [
        {
            "role": "user",
            "content": `Give me a detailed description of the anime: ${title}. Do not add markdown characters. If you want to bold us bold tags in html etc`
        }]
    }
    const post_data_json = JSON.stringify(post_data);

    const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: "POST",
        headers: {
            "Authorization": `Bearer ${groq_auth_token}`,
            "Content-Type": 'application/json',
            'Content-Length': Buffer.byteLength(post_data_json)
        }
    }

    const groq_req = https.request(options, (groq_res) => {
        let body = ""
        groq_res.on("data", (chunk) => {
            body += chunk
        })
        groq_res.on("end", () => {
            const groqJSON = JSON.parse(body)
            const result = groqJSON.choices[0].message.content
            res.writeHead(200, {"Content-Type": "text/html"});
	        res.end(`<div style="height:100vh;display:flex;flex-direction:row;align-items:center;justify-content:center;"><img src="${picture}" alt="${title}"/><p>${result}</p></div>`);
        })
    })

    groq_req.on("error", (err) => {
        console.error("Request error:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to retrieve anime list.");
    });
    
    groq_req.write(post_data_json);
    groq_req.end();
}