var fs         = require("fs");
var path       = require("path");
var mdeps      = require("module-deps");
var UglifyJS   = require("uglify-js");

function build(config, opts, callback){
    // Get Architect Config
    if (typeof config == "string") {
        fs.readFile(config, "utf8", function(err, data){
            if (err) return callback(err);
            var str = data.match(/require.plugins\s*=\s*(\[[\s\S]*\])/)[1];
            
            try { var json = eval(str); }
            catch(e) { return callback(e); }
            
            opts.configFile = data;
            build(json, opts, callback);
        });
        return;
    }
    
    // Load all architect modules as main files
    var mains = [], options = {};
    config.forEach(function(pkg){
        if (typeof pkg == "string") {
            mains.push(pkg);
        }
        else {
            mains.push(pkg.packagePath);
            options[pkg.packagePath] = pkg;
        }
    });
    
    if (!mains.length)
        return callback(new Error("Config contains no packages"));
    
    // Add Architect
    var archName = path.resolve(__dirname + "/../architect/architect.js");
    if (!opts.noArchitect) {
        mains.push(archName);
        (opts.ignore || (opts.ignore = [])).push(
            //path.resolve(__dirname + "/../architect/events"),
            path.resolve(__dirname + "/../architect/path"),
            path.resolve(__dirname + "/../architect/fs")
        );
    }
    
    // Add RequireJS
    if (opts.withRequire)
        mains.unshift(path.resolve(__dirname + "/build_support/mini_require.js"));
    
    // Find their deps
    var stream = mdeps(mains, opts);
    var sources = [];
    
    stream.on("data", function(data){
        sources.push(data);
    })
    stream.on("end", function(){
        var lutNonJs = {};
        
        // Filter sources
        (opts.filter || []).forEach(function(filter){
            sources = sources.filter(function(pkg){
                return pkg.id.indexOf(filter) !== 0;
            });
        });
        
        // Add additional packages
        (opts.packages || []).forEach(function(main){
            sources.unshift({
                id     : main,
                file   : main,
                source : fs.readFileSync(path.resolve(__dirname + "/" 
                    + main.replace(/\.js$/, "") + ".js"), "utf8") // @todo make this async
            });
        });
        
        // Rewrite all the defines to include the id as first arg
        rewriteDefines(sources, archName, lutNonJs);
        
        // Include the architect config at the end in the same way as the tests
        if (!opts.noArchitect) {
            var source;
            if (opts.includeConfig) {
                source = opts.configFile
                    + 'require(["architect"], function (architect) {'
                    + '    architect.resolveConfig(require.plugins, function (err, config) {'
                    + '        if (err) throw err;'
                    + '        architect.createApp(config);'
                    + '    });'
                    + '});';
            }
            else {
                source = 'require(["architect", "./architect-config"], function (architect, plugins) {'
                    + '    architect.resolveConfig(plugins, function (err, config) {'
                    + '        if (err) throw err;'
                    + '        architect.createApp(config);'
                    + '    });'
                    + '});';
                
                var output = (opts.outputFolder || ".") + "/" + (opts.outputFile || "architect-config.js");
                fs.writeFile(output, opts.configFile, function(err){
                    if (!err)
                        console.log("Written config file in '" + output + "'.");
                });
            }
            
            sources.push({
                id     : "bootstrap",
                file   : "bootstrap",
                source : source
            });
        }
        
        console.log("Procesing " + sources.length + " files.");
        
        // Concatenate all files using uglify2 with source maps
        var result;
        if (opts.compress)
            result = compact(sources, opts);
        else {
            result = {
                code : sources.map(function(src){ return src.source; }).join("\n"),
                map : ""
            };
        }
        
        // Wrap the entire thing in a define of it's own
        // @todo it might be better to do the replaces before the map file is created
        var code = result.code;
        // "define(function(require, exports, module){" 
        //     + result.code 
        //     + "});";
        code = code
            .replace(/(["'])require\(/g, "$1req$1+$1uire(")
            .replace(/REPLACE>([^<]*)<REPLACE/g, function(m, id){
                return lutNonJs[id];
            })
            .replace(/\((["'])[^"]*text\!([^'"]+)/g, "($1$2");
        
        // Write output code
        output = (opts.outputFolder || ".") + "/" + (opts.outputFile || "build.js");
        fs.writeFile(output, code, function(err){
            if (err) return callback(err);
            console.log("Written output in '" + output + "'");
        });
        
        // Write map file
        if (opts.mapFile) {
            output = (opts.outputFolder || ".") + "/" + opts.mapFile;
            fs.writeFile(output, result.map, function(err){
                if (err) return callback(err);
                console.log("Written map file in '" + output + "'");
            });
        }
        
        // Return a public API (if any)
    })
}

function compact(sources, opts){
    var toplevel = null;
    sources.forEach(function(pkg){
        console.log("Adding '" + pkg.file + "'.");
        
        toplevel = UglifyJS.parse(pkg.source, {
            filename: pkg.file.replace(new RegExp("^" + opts.basepath + "/"), ""), //@todo remove prefix
            toplevel: toplevel
        });
    });
    
    /**
     * UglifyJS contains a scope analyzer that you need to call manually before 
     * compressing or mangling. Basically it augments various nodes in the AST 
     * with information about where is a name defined, how many times is a name 
     * referenced, if it is a global or not, if a function is using eval or the 
     * with statement etc. I will discuss this some place else, for now what's 
     * important to know is that you need to call the following before doing 
     * anything with the tree:
     */
    toplevel.figure_out_scope();
    
    var compressor = UglifyJS.Compressor({});
    var compressed_ast = toplevel.transform(compressor);
    
    /**
     * After compression it is a good idea to call again figure_out_scope 
     * (since the compressor might drop unused variables / unreachable code and 
     * this might change the number of identifiers or their position). 
     * Optionally, you can call a trick that helps after Gzip (counting 
     * character frequency in non-mangleable words). 
     */
    compressed_ast.figure_out_scope();
    compressed_ast.compute_char_frequency();
    //compressed_ast.mangle_names({except: ["$", "require", "exports"]});
    
    var stream;
    if (opts.mapFile) {
        // Generate a source map
        var source_map = UglifyJS.SourceMap({
            file : opts.mapFile || "build.js.map",
            root : opts.mapRoot
        });
        stream = UglifyJS.OutputStream({
            source_map: source_map
        });
    }
    else {
        stream = UglifyJS.OutputStream();
    }
    compressed_ast.print(stream);
    
    return {
        code : stream.toString(),
        map  : source_map.toString() // json output for your source map
    }
}

function rewriteDefines(sources, archName, lut){
    sources.forEach(function(pkg){
        if (pkg.id.indexOf("text!") > -1) {
            //pkg.id = pkg.file;
            lut[pkg.id] = pkg.source.replace(/\n/g, "\\n").replace(/"/g, "\\\"");
            pkg.source = "define(\"" + pkg.id.replace(/^.*\!/, "") + "\",[],function(){return \""
                + "REPLACE>" + pkg.id + "<REPLACE"
                + "\"});"
        }
        else {
            if (pkg.id == archName) {
                pkg.source = pkg.source
                    .replace(/define\(/, "define(\"architect\", ")
                    .replace(/require\(['"](?:events|fs|path)['"]\)/g, "{}");
            }
            else {
                pkg.source = pkg.source
                    .replace(/define\((\s*[\[f])/, "define(\"" + pkg.id + '", $1');
            }
            pkg.source = pkg.source
                .replace(/define\(([^,\[\]]+,\s*)?\[([^\]]*)\],([^\)]*)/g, function(m, first, deps, func){
                    if (func.indexOf("function") > -1) {
                        return "define(" + first + "[], " 
                            + func.replace(/(function.*\{)/, "$1\n" 
                            + deps.split(",").map(function(dep){
                                  //@todo whack way to do arguments. Use Treehugger instead
                                  return "var " + dep.replace(/["']/g, "") + " = require(" + dep + ")";
                              }).join(";\n"));
                    }
                    else {
                        return "define(" + first + "[], function(){" 
                            + "return " + func + "(" 
                            + deps.split(",").map(function(dep){
                                  //@todo whack way to do arguments. Use Treehugger instead
                                  return "require(" + dep + ")";
                              }).join(", ") 
                            + ");}";
                    }
                });
        }
    });
}

module.exports = build;

var packagePaths = {
    "ace"        : __dirname + "/../../node_modules/ace/lib/ace",
    "plugins"    : __dirname + "/../../plugins-client",
    "events"     : __dirname + "/../../jam/events/events.js",
    "treehugger" : __dirname + "/../../node_modules/treehugger/lib/treehugger"
};

build(__dirname + "/../../configs/logicblox.js", {
    enableBrowser : true,
    packagePaths  : packagePaths,
    includeConfig : true,
    compress      : true,
    basepath      : "/home/ubuntu/vfs-server",
    filter        : ["ace"],
    // copy          : [],
    packages      : ["../ace/build/src/ace"],
    outputFolder  : __dirname + "/build",
    outputFile    : "logicblox.js",
    mapFile       : "logicblox.js.map"
    // mapRoot       : "http://example.com"
}, function(err, data){
    console.error(err.message);
});

build([
    "ace/worker/worker",
    "ace/lib/fixoldbrowsers",
    
    "plugins/c9.language/worker",
    "plugins/c9.language.generic/local_completer",
    "plugins/c9.language.generic/snippet_completer",
    "plugins/c9.language.generic/open_files_local_completer",
    "plugins/c9.language.generic/mode_completer",
    // "plugins/c9.language.javascript/parse",
    // "plugins/c9.language.javascript/scope_analyzer",
    // "plugins/c9.language.javascript/jshint",
    // "plugins/c9.language.javascript/debugger",
    // "plugins/c9.language.javascript/outline",
    // "plugins/c9.language.javascript/jumptodef"
    "plugins/c9.language.logiql/logiql_handler"
], {
    enableBrowser : true,
    includeConfig : false,
    noArchitect   : true,
    compress      : true,
    packagePaths  : packagePaths,
    //filter        : ["ace"],
    basepath      : "/home/ubuntu/vfs-server",
    outputFolder  : __dirname + "/build",
    outputFile    : "worker-c9.language.js",
    mapFile       : "worker-c9.language.js.map"
    // mapRoot       : "http://example.com"
}, function(err, data){
    console.error(err.message);
});