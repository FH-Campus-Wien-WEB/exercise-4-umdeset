const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");
const {data} = require("express-session/session/cookie");
const e = require("express");

const app = express();

// Parse urlencoded bodies
app.use(bodyParser.json());

// Session middleware
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

app.post("/login", function (req, res) {
  const { username, password } = req.body;
  const user = userModel[username];
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = {
      username,
      firstName: user.firstName,
      lastName: user.lastName,
      loginTime: new Date().toISOString(),
    };
    res.send(req.session.user);
  } else {
    res.sendStatus(401);
  }
});

// Task 1.3: Implement the GET `/logout` endpoint and requireLogin
// protection. Implement logout by destroying the session 
// with error handling. Protect all endpoints that need 
// authentication with `requireLogin`.

app.get("/logout", function (req, res) {
  req.session.destroy(function (err) {
    if (err) {
      return res.sendStatus(500);
    }
    res.sendStatus(200);
  });
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).send("Not logged in");
  }
  next();
}


app.get("/movies", requireLogin, function (req, res) {
  const username = req.session.user.username;
  let movies = Object.values(movieModel.getUserMovies(username));
  const queriedGenre = req.query.genre;
  if (queriedGenre) {
    movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
  }
  res.send(movies);
});

// Configure a 'get' endpoint for a specific movie
app.get("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  const movie = movieModel.getUserMovie(username, id);

  if (movie) {
    res.send(movie);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'put' endpoint for a specific movie to update or insert a movie
app.put("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const imdbID = req.params.imdbID;
  const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

  if (!exists) {
    // Task 2.3: Fetch the movie data from OmdbAPI, follow the pattern used further down 
    // in the GET /search endpoint. Implement conversion of the OmdbAPI response to the 
    // movie format used in the frontend. Make sure to handle errors and timeouts properly.
    const url = `http://www.omdbapi.com/?i=${imdbID}&apikey=${config.omdbApiKey}`; //damot der server weiss unter welcher adresse er nach diesem film suchen muss.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);
    fetch(url, {signal: controller.signal})
        .then(apiRes => {
          clearTimeout(timeoutId); //antwort ist da also anhalten
          if (!apiRes.ok) {
            return res.sendStatus(apiRes.status);
          }
          return apiRes.text().then(data => {
            let movieData;
            try {
              movieData = JSON.parse(data);
            }catch (parseError) {
              console.error(`Fehler beim parsen`, parseError);
              return res.sendStatus(500);
            }
            if (movieData.Response === 'True') {

              // Datum sicher umwandeln (von "23 Jun 1989" zu "1989-06-23")
              let formattedDate = movieData.Released;
              if (movieData.Released !== "N/A") {
                const d = new Date(movieData.Released);
                if (!isNaN(d)) formattedDate = d.toISOString().split('T')[0];
              }

              // OMDb-Daten in  übersetzen!
              const convertedMovie = {
                imdbID: movieData.imdbID,
                Title: movieData.Title,
                Released: formattedDate,
                Runtime: parseInt(movieData.Runtime) || null, // Aus "126 min" wird 126
                Genres: movieData.Genre ? movieData.Genre.split(", ") : [],
                Directors: movieData.Director ? movieData.Director.split(", ") : [],
                Writers: movieData.Writer ? movieData.Writer.split(", ") : [],
                Actors: movieData.Actors ? movieData.Actors.split(", ") : [],
                Plot: movieData.Plot,
                Poster: movieData.Poster,
                Metascore: parseInt(movieData.Metascore) || null,
                imdbRating: parseFloat(movieData.imdbRating) || null
              };

              // Jetzt speichern wir den Film in der Datenbank
              movieModel.setUserMovie(username, imdbID, convertedMovie);
              res.sendStatus(201);

            } else {
              res.sendStatus(404);
            }
          });
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          if (err.name === "AbortError") {
            console.error(`Timeout bei anfrage`);
            return res.sendStatus(504);
          }
          console.error('OMDb API Fehler:', err);
          return res.sendStatus(500);
        });
  } else {
    movieModel.setUserMovie(username, imdbID, req.body);
    res.sendStatus(200);
  }
});

app.delete("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  if (movieModel.deleteUserMovie(username, id)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'get' endpoint for genres of all movies of the current user
app.get("/genres", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const genres = movieModel.getGenres(username);
  genres.sort();
  res.send(genres);
});

/* Task 2.1. Add the GET /search endpoint: Query omdbapi.com and return
   a list of the results you obtain. Only include the properties 
   mentioned in the README when sending back the results to the client. */
app.get("/search", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const query = req.query.query;
  if (!query) {
    return res.sendStatus(400);
  }

  const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

  fetch(url, { signal: controller.signal })
    .then(apiRes => {
      clearTimeout(timeoutId);
      if (!apiRes.ok) {
        return res.sendStatus(apiRes.status);
      }
      return apiRes.text().then(data => {
        let response;
        try {
          response = JSON.parse(data);
        } catch (parseError) {
          console.error('Failed to parse OMDb response:', parseError);
          return res.sendStatus(500);
        }

        if (response.Response === 'True') {
          const results = response.Search
            .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
            .map(movie => ({
              Title: movie.Title,
              imdbID: movie.imdbID,
              Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
            }));
          res.send(results);
        } else {
          res.send([]);
        }
      });
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error('OMDb API request timeout');
        return res.sendStatus(504);
      }
      console.error('OMDb API error:', err);
      res.sendStatus(500);
    });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);
