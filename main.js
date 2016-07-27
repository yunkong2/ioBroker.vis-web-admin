/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var express = require('express');
var fs =      require('fs');
//var Stream =  require('stream');
var utils =   require(__dirname + '/lib/utils'); // Get common adapter utils

var session;// =           require('express-session');
var cookieParser;// =      require('cookie-parser');
var bodyParser;// =        require('body-parser');
var AdapterStore;// =      require(__dirname + '/../../lib/session.js')(session);
var passportSocketIo;// =  require(__dirname + "/lib/passport.socketio.js");
var password;// =          require(__dirname + '/../../lib/password.js');
var passport;// =          require('passport');
var LocalStrategy;// =     require('passport-local').Strategy;
var flash;// =             require('connect-flash'); // TODO report error to user

var webServer =  null;
var store =      null;
var secret =     'Zgfr56gFe87jJOM'; // Will be generated by first start
var socketUrl =  '';
var cache =      {}; // cached web files
var ownSocket =  false;
var lang =       'en';

var redirectLink = '';
var systemDictionary = {
    'Directories': {'en': 'Directories', 'de': 'Verzeichnise', 'ru': '����'},
    'your are lost': {
        'en': 'It seems to be you are lost. Here are some files, that you can open:',
        'de': 'Sieht so aus, als ob du verlaufen bist. Hier sind die Pfade, wohin man gehen kann:',
        'ru': '������, ��� ���-�� ���������. ��� ���� �� ������� ����� �����:'
    }
};


var adapter = utils.adapter({
    name: 'vis-web-admin',
    install: function (callback) {
        if (typeof callback === 'function') callback();
    },
    objectChange: function (id, obj) {
        if (!ownSocket && id === adapter.config.socketio) {
            if (obj && obj.common && obj.common.enabled && obj.native) {
                socketUrl = ':' + obj.native.port;
            } else {
                socketUrl = '';
            }
        }
        if (webServer.io) webServer.io.publishAll('objectChange', id, obj);
        if (webServer.api && adapter.config.auth) webServer.api.objectChange(id, obj);
        if (id === 'system.config') {
            lang = obj && obj.common && obj.common.language ? obj.common.language : 'en';
        }
    },
    stateChange: function (id, state) {
        if (webServer.io) webServer.io.publishAll('stateChange', id, state);
    },
    unload: function (callback) {
        try {
            adapter.log.info('terminating http' + (webServer.settings.secure ? 's' : '') + ' server on port ' + webServer.settings.port);
            webServer.server.close();
            adapter.log.info('terminated http' + (webServer.settings.secure ? 's' : '') + ' server on port ' + webServer.settings.port);

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        adapter.config.vis = adapter.config.vis || 'vis.0';

        // Generate secret for session manager
        adapter.getForeignObject('system.config', function (err, obj) {
            if (!err && obj) {
                if (!obj.native || !obj.native.secret) {
                    obj.native = obj.native || {};
                    require('crypto').randomBytes(24, function (ex, buf) {
                        secret = buf.toString('hex');
                        adapter.extendForeignObject('system.config', {native: {secret: secret}});
                        main();
                    });
                } else {
                    secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.logger.error('Cannot find object system.config');
            }
        });

        // read redirectLink
        if (adapter.config.loginRedirect) {
            adapter.getForeignObject(adapter.config.loginRedirect, function (err, obj) {
                if (obj && obj.native) {
                    redirectLink = 'http' + (obj.native.secure ? 's' : '') + '://redirect:' +  obj.native.port + '/vis/';
                }
            });
        }


        // information about connected socket.io adapter
        if (adapter.config.socketio && adapter.config.socketio.match(/^system\.adapter\./)) {
            adapter.getForeignObject(adapter.config.socketio, function (err, obj) {
                if (obj && obj.common && obj.common.enabled && obj.native) socketUrl = ':' + obj.native.port;
            });
            // Listen for changes
            adapter.subscribeForeignObjects(adapter.config.socketio);
        } else {
            socketUrl = adapter.config.socketio;
            ownSocket = (socketUrl != 'none');
        }

        // Read language
        adapter.getForeignObject('system.config', function (err, data) {
            if (data && data.common) lang = data.common.language || 'en';
        });
    }
});

function main() {
    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates(function (err, certificates) {
            adapter.config.certificates = certificates;
            webServer = initWebServer(adapter.config);
        });
    } else {
        webServer = initWebServer(adapter.config);
    }
}

function addUser(user, pw, options, callback) {
    adapter.getForeignObject('system.user.' + user, options, function (err, obj) {
        if (obj) {
            if (typeof callback == 'function') callback('User yet exists');
        } else {
            adapter.setForeignObject('system.user.' + user, {
                type: 'user',
                common: {
                    name:    user,
                    enabled: true,
                    groups:  []
                }
            }, function () {
                adapter.setPassword(user, pw, callback);
            });
        }
    });
}

function _detectViews(projectDir, user, callback) {
    adapter.readDir(adapter.config.vis, '/' + projectDir, {user: user, filter: true}, function (err, dirs) {
        // find vis-views.json
        var result = null;
        for (var f = 0; f < dirs.length; f++) {
            if (dirs[f].file === 'vis-views.json' && (!dirs[f].acl || dirs[f].acl.read)) {
                result = result || {};
                result.name = projectDir;
                result.readOnly = dirs[f].acl && !dirs[f].acl.write;
                result.owner = (dirs[f].acl ? dirs[f].acl.owner : '');
            }
            if (dirs[f].file.match(/\.png$/i) || dirs[f].file.match(/\.jpg$/i) || dirs[f].file.match(/\.gif$/i)) {
                result = result || {};
                result.image = '/vis.0/' + projectDir + '/' + dirs[f].file;
            }
        }
        callback(err, result);
    });
}

function readProjects(user, callback) {
    adapter.readDir(adapter.config.vis, '/', {user: user}, function (err, dirs) {
        var result = [];
        var count = 0;
        if (err || !dirs) {
            callback(err, result);
            return;
        }
        for (var d = 0; d < dirs.length; d++) {
            if (dirs[d].isDir) {
                count++;
                _detectViews(dirs[d].file, user, function (subErr, project) {
                    if (project) result.push(project);

                    err = err || subErr;
                    if (!(--count)) callback(err, result);
                });
            }
        }
    }.bind(this));
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function initWebServer(settings) {

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };
    adapter.subscribeForeignObjects('system.config');

    adapter.config.ttl = parseInt(adapter.config.ttl, 10) || 3600;

    adapter.config.defaultUser = adapter.config.defaultUser || 'system.user.admin';
    if (!adapter.config.defaultUser.match(/^system\.user\./)) adapter.config.defaultUser = 'system.user.' + adapter.config.defaultUser;

    if (settings.port) {
        if (settings.secure) {
            if (!adapter.config.certificates) {
                return null;
            }
        }
        server.app = express();
        if (settings.auth) {
            session =          require('express-session');
            cookieParser =     require('cookie-parser');
            bodyParser =       require('body-parser');
            AdapterStore =     require(utils.controllerDir + '/lib/session.js')(session, adapter.config.ttl);
            passportSocketIo = require('passport.socketio');
            password =         require(utils.controllerDir + '/lib/password.js');
            passport =         require('passport');
            LocalStrategy =    require('passport-local').Strategy;
            flash =            require('connect-flash'); // TODO report error to user

            store = new AdapterStore({adapter: adapter});

            passport.use(new LocalStrategy(
                function (username, password, done) {
                    adapter.checkPassword(username, password, function (res) {
                        if (res) {
                            return done(null, username);
                        } else {
                            return done(null, false);
                        }
                    });
                }
            ));
            passport.serializeUser(function (user, done) {
                done(null, user);
            });

            passport.deserializeUser(function (user, done) {
                done(null, user);
            });

            server.app.use(cookieParser());
            server.app.use(bodyParser.urlencoded({
                extended: true
            }));
            server.app.use(bodyParser.json());
            server.app.use(bodyParser.text());
            server.app.use(session({
                secret:            secret,
                saveUninitialized: true,
                resave:            true,
                store:             store
            }));
            server.app.use(passport.initialize());
            server.app.use(passport.session());
            server.app.use(flash());

            server.app.post('/login', function (req, res) {
                var redirect = '/';
                var parts;
                if (req.body.origin) {
                    parts = req.body.origin.split('=');
                    if (parts[1]) redirect = decodeURIComponent(parts[1]);
                }
                if (req.body && req.body.username && adapter.config.addUserName && redirect.indexOf('?') == -1) {
                    parts = redirect.split('#');
                    parts[0] += '?' + req.body.username;
                    redirect = parts.join('#');
                }
                var authenticate = passport.authenticate('local', {
                    successRedirect: redirect,
                    failureRedirect: '/login/index.html' + req.body.origin + (req.body.origin ? '&error' : '?error'),
                    failureFlash: 'Invalid username or password.'
                })(req, res);
            });

            server.app.get('/logout', function (req, res) {
                req.logout();
                res.redirect('/login/index.html');
            });

            // route middleware to make sure a user is logged in
            server.app.use(function (req, res, next) {
                if (req.isAuthenticated() ||
                    /^\/login\//.test(req.originalUrl) ||
                    /\.ico$/.test(req.originalUrl)
                ) return next();
                res.redirect('/login/index.html?href=' + encodeURIComponent(req.originalUrl));
            });
        } else {
            server.app.get('/login', function (req, res) {
                res.redirect('/');
            });
            server.app.get('/logout', function (req, res) {
                res.redirect('/');
            });
        }

        // Init read from states
        server.app.get('/state/*', function (req, res) {
            try {
                var fileName = req.url.split('/', 3)[2].split('?', 2);
                adapter.getBinaryState(fileName[0], {user: req.user ? 'system.user.' + req.user : adapter.config.defaultUser}, function (err, obj) {
                    if (!err && obj !== null && obj !== undefined) {
                        res.set('Content-Type', 'text/plain');
                        res.status(200).send(obj);
                    } else {
                        res.status(404).send('404 Not found. File ' + fileName[0] + ' not found');
                    }
                });
            } catch (e) {
                res.status(500).send('500. Error' + e);
            }
        });

        server.app.get('*/_socket/info.js', function (req, res) {
            res.set('Content-Type', 'application/javascript');
            res.status(200).send('var socketUrl = "' + socketUrl + '"; var socketSession = "' + '' + '"; sysLang="' + lang + '";');
        });

        // Enable CORS
        if (settings.socketio) {
            server.app.use(function (req, res, next) {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, *');

                // intercept OPTIONS method
                if ('OPTIONS' === req.method) {
                    res.status(200).send(200);
                } else {
                    next();
                }
            });
        }

        var appOptions = {};
        if (settings.cache) appOptions.maxAge = 30758400000;

        // deliver web files from objectDB
        server.app.use('/', function (req, res) {
            var url = decodeURI(req.url);

            if (server.api && server.api.checkRequest(url)) {
                server.api.restApi(req, res);
                return;
            }

            if (url === '/') {
                try {
                    // read all instances
                    adapter.objects.getObjectView('system', 'instance', {}, function (err, instances) {
                        adapter.objects.getObjectView('system', 'adapter', {}, function (err, adapters) {
                            var check = [];
                            var a;
                            for (a = 0; a < adapters.rows.length; a++) {
                                check.push(adapters.rows[a].id.substring('system.adapter.'.length));
                                check.push(adapters.rows[a].id.substring('system.adapter.'.length) + '.admin');
                            }
                            for (a = 0; a < instances.rows.length; a++) {
                                check.push(instances.rows[a].id.substring('system.adapter.'.length));
                            }
                            readDirs(check, function (dirs) {
                                var text = '<h2>' + systemDictionary['Directories'][lang] + '</h2><p>' + systemDictionary['your are lost'][lang] + '</p>';
                                dirs.sort();
                                for (var d = 0; d < dirs.length; d++) {
                                    if (dirs[d].indexOf('vis/') !== -1 || dirs[d].indexOf('mobile/') !== -1) {
                                        text += (text ? '<br>' : '') + '<a href="/' + dirs[d] + '"><b>' + dirs[d] + '</b></a>';
                                    } else {
                                        text += (text ? '<br>' : '') + '<a href="/' + dirs[d] + '">' + dirs[d] + '</a>';
                                    }
                                }
                                res.set('Content-Type', 'text/html');
                                res.status(200).send('<html><head><title>iobroker.web</title></head><body>' + text + '</body>');

                            });
                        });
                    });
                } catch (e) {
                    res.status(500).send('500. Error' + e);
                }
                return;
            }

            // add index.html
            url = url.replace(/\/($|\?|#)/, '/index.html$1');

            if (url.match(/^\/adapter\//)) {
                // add .admin to adapter name
                url = url.replace(/^\/adapter\/([a-zA-Z0-9-_]+)\//, '/$1.admin/');
            }

            if (url.match(/^\/lib\//)) {
                url = '/' + adapter.name + url;
            }

            url = url.split('/');
            // Skip first /
            url.shift();
            // Get ID
            var id = url.shift();
            url = url.join('/');
            var pos = url.indexOf('?');
            var noFileCache;
            if (pos != -1) {
                url = url.substring(0, pos);
                // disable file cache if request like /vis/files/picture.png?noCache
                noFileCache = true;
            }
            if (id.match(/^create\.html/) && !url) {
                res.contentType('application/javascript');
                console.log(JSON.stringify(req.query));
                if (!req.query.user || req.query.user.match(/\s/)) {
                    res.send(JSON.stringify({error: 'Spaces are not allowed or empty user name'}));
                } else if (req.query.user.match(/\./)) {
                    res.send(JSON.stringify({error: 'Dots are not allowed in the user name'}));
                } else if (!req.query.password) {
                    res.send(JSON.stringify({error: 'Empty passwords are not allowed'}));
                } else {
                    addUser(req.query.user, req.query.password, {}, function (err) {
                        if (err) {
                            res.send(JSON.stringify({error: err}));
                        } else {
                            // store email
                            adapter.getForeignObject('system.user.' + req.query.user, function (err, obj) {
                                if (err || !obj) {
                                    res.send(JSON.stringify({error: err}));
                                } else {
                                    obj.native = obj.native || {};
                                    obj.native.email = req.query.mail;
                                    adapter.setForeignObject('system.user.' + req.query.user, obj, function (err) {
                                        if (err) {
                                            res.send(JSON.stringify({error: err}));
                                        } else {
                                            // Add user to default group
                                            if (adapter.config.newUserGroup) {
                                                adapter.getForeignObject(adapter.config.newUserGroup, function (err, obj) {
                                                    obj.common.members = obj.common.members || [];
                                                    if (obj.common.members.indexOf('system.user.' + req.query.user) == -1) {
                                                        obj.common.members.push('system.user.' + req.query.user);
                                                        adapter.setForeignObject(adapter.config.newUserGroup, obj, function (err, obj) {
                                                            if (err) {
                                                                res.send(JSON.stringify({error: err}));
                                                            } else {
                                                                res.send(JSON.stringify({status: 'ok'}));
                                                            }
                                                        });
                                                    } else {
                                                        console.warn('Strange. User "' + req.query.user + '" is new, but yet exists in the group.');
                                                        res.send(JSON.stringify({status: 'ok'}));
                                                    }
                                                });
                                            } else {
                                                res.send(JSON.stringify({status: 'ok'}));
                                            }
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
                return;
            }

            if (id === 'favicon.png' && !url) {
                var buffer = fs.readFileSync(__dirname + '/www/favicon.png');
                if (buffer === null || buffer === undefined) {
                    res.contentType('text/html');
                    res.send('File ' + url + ' not found', 404);
                } else {
                    res.send(buffer);
                }
                return;
            }

            if (id == 'index.html' && !url) {
                var buffer = fs.readFileSync(__dirname + '/www/index.html');
                if (buffer === null || buffer === undefined) {
                    res.contentType('text/html');
                    res.send('File ' + url + ' not found', 404);
                } else {
                    var text = buffer.toString();
                    text = text.replace(/%%REDIRECT%%/g, redirectLink);
                    res.contentType('text/html');

                    // Fill the projects
                    readProjects(req.user ? 'system.user.' + req.user : adapter.config.defaultUser, function (err, projects) {
                        if (!err && projects) {
                            text = text.replace(/%%PROJECTS%%/, JSON.stringify(projects));
                            res.send(text);
                        } else {
                            text = text.replace(/%%PROJECTS%%/, err);
                            res.send(text);
                        }
                    });
                }
                return;
            }

            if (settings.cache && cache[id + '/' + url] && !noFileCache) {
                res.contentType(cache[id + '/' + url].mimeType);
                res.status(200).send(cache[id + '/' + url].buffer);
            } else {
                if (id === 'login' && url === 'index.html') {
                    var buffer = fs.readFileSync(__dirname + '/www/login/index.html');
                    if (buffer === null || buffer === undefined) {
                        res.contentType('text/html');
                        res.status(200).send('File ' + url + ' not found', 404);
                    } else {
                        // Store file in cache
                        if (settings.cache) {
                            cache[id + '/' + url] = {buffer: buffer.toString(), mimeType: 'text/html'};
                        }
                        res.contentType('text/html');
                        res.status(200).send(buffer.toString());
                    }

                } else {
                    adapter.readFile(id, url, {user: req.user ? 'system.user.' + req.user : adapter.config.defaultUser, noFileCache: noFileCache}, function (err, buffer, mimeType) {
                        if (buffer === null || buffer === undefined || err) {
                            res.contentType('text/html');
                            res.status(404).send('File ' + url + ' not found: ' + err);
                        } else {
                            // Store file in cache
                            if (settings.cache) {
                                cache[id + '/' + url] = {buffer: buffer, mimeType: mimeType || 'text/javascript'};
                            }
                            res.contentType(mimeType || 'text/javascript');
                            res.status(200).send(buffer);
                        }
                    });
                }
            }
        });

        if (settings.secure) {
            server.server = require('https').createServer(adapter.config.certificates, server.app);
        } else {
            server.server = require('http').createServer(server.app);
        }
        server.server.__server = server;
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    if (server.server) {
        adapter.getPort(settings.port, function (port) {
            if (port != settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            server.server.listen(port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined);
            adapter.log.info('http' + (settings.secure ? 's' : '') + ' server listening on port ' + port);
        });
    }

    // Activate integrated simple API
    if (settings.simpleapi) {
        var SimpleAPI = require(utils.appName + '.simple-api/lib/simpleapi.js');

        // Subscribe on user changes to manage the permissions cache
        adapter.subscribeForeignObjects('system.group.*');
        adapter.subscribeForeignObjects('system.user.*');

        server.api = new SimpleAPI(server.server, {secure: settings.secure, port: settings.port}, adapter);
    }

    // Activate integrated socket
    if (ownSocket) {
        var IOSocket = require(utils.appName + '.socketio/lib/socket.js');
        var socketSettings = JSON.parse(JSON.stringify(settings));
        // Authentication checked by server itself
        socketSettings.auth        = false;
        socketSettings.secret      = secret;
        socketSettings.store       = store;
        socketSettings.ttl         = adapter.config.ttl || 3600;
        server.io = new IOSocket(server.server, socketSettings, adapter);
    }

    if (server.server) {
        return server;
    } else {
        return null;
    }
}
