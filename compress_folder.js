var compress = require("./compress");
var fs = require("fs");

function compressDir(dir, opts) {
    if (process.platform == "win32" && dir[0] == "/")
        dir = dir.replace(/(?:\/cygdrive)?\/(\w)\//, "$1:/");
    console.log("compressing", dir);
    var files = fs.readdirSync(dir);
    files.forEach(function(x) {
        var path = dir + "/" + x;
        try {
            var stat = fs.statSync(path);
        } catch(e) {
            return console.error(e);
        }
        if (stat.isDirectory()) {
            compressDir(path);
        } else if (/\.js$/.test(x)) {
            var source = fs.readFileSync(path, "utf8");
            if (source[0] != "#") {
                try {
                    // ignore already minified files
                    if (source.indexOf("\n") > 200)
                        return;
                    source = compress(source, opts).code;
                    fs.writeFileSync(path, source, "utf8");
                } catch(e) {
                    console.error(e);
                }
            }
        }
    });
}

module.exports = compressDir;

// var dir = __dirname + "../../../build/win32/app.nw";
// compressDir(dir);