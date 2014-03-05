/**
*@description 本地静态服务
*@updateTime 2014-02-20/17
*/
var fs = require("fs");
var SS = require('node-static');
var http = require('http');
var url = require('url');
var Path = require('path');
var vm = require('vm');
var route = require("./route");
var logger = require('../lib/log/logger.js').getLogger("vhosts");

var routeList = {}; //路由列表 key为domain value为port
var staticPaths = {}; //存放开启的server对象,key为path
/**
*@description 随机生成一个未被占用的端口号
*@param cb {Function} 回调函数，一个参数便是生成的端口号
*  通过创建开启一个测试服务，使用随机得到的端口号监听。
*  若出现错误便认为这个端口不可用，重新生成一个再测试；
*  若可以监听使用就关闭测试服务，并通过回调返回这个端口号。
*/
function getPort(cb) {
	var times = 10;
	_getPort();

	function _getPort() {
		var port = parseInt(Math.random() * 8000 + 1000);
		if (times-- < 0) {
			cb(null, "OMG~！找不到可用端口。。");
		} else {
			var server = http.createServer();
			server.on("error", function() {
				//错误说明不可用，则重新获取一个
				_getPort();
			});
			server.on("listening", function() {
				//可用，则关闭开启的测试服务，返回端口号
				server.close();
				cb(port);
			});
			server.listen(port);
		}
	}
}

/**
*@description 开启一个server 返回监听的端口号
*@param path {String}: 需要开启服务的文件路径，必选
*       cb {Function}: 回调函数，传递一个开启的server信息对象。
*       options {Object}: 扩展对象
*/
function startServer(path, cb, options) {
	var cb = cb || function() {};
	var options = options || {};
	fs.exists(path, function(t) {
		if (t) {
			if (!options.port) {
				getPort(function(p, err) {
					p ? cb(_start(path, p, options)) : cb({
						err: err
					});
				});
			} else {
				cb(_start(path, options.port, options));
			}
		} else {
			cb({
				err: "static-server: 指定路径不合法~！" + path
			});
		}
	});


	function _start(path, port, options) {
		//启动server
		var fileServer = new SS.Server(path, options);
		var server = http.createServer(function(request, response) {
			if (Path.extname(request.url) == '.node') {
				var file = Path.join(path, request.url);
				if(fs.existsSync(file)){
					var code = fs.readFileSync(file,'utf-8');
					vm.runInNewContext(code,{
						route:function(run){
							run(request,response)
						}
					});
					return;
				}
			}
			request.addListener('end', function() {
				fileServer.serve(request, response, function(err, result) {
					if (err) {
						response.writeHead(err.status, err.headers);
						response.end();
						return;
					}
				});
			}).resume();
		});
		server.on("close", function() {
			logger.debug("static server closed~! " + path);
		});

		server.listen(port);
		logger.debug("Server runing at port: " + port + ". path: " + path);
		return {
			path: path,
			port: port,
			server: server
		};
	}
}

/**
*@description 启动/更新服务
*@param list {Array} 要启动的服务列表
*/
function update(list) {
	if (list && list instanceof Array && list.length > 0) {
		var newQueue = {},
		newQueue_num = 0; //存放需要新开启的服务路径列表
		var i = 0,
		item, path, domain, result;

		routeList = {}; //初始路由列表
		for (; i < list.length; i++) {
			item = list[i];
			path = item.path;
			domain = item.domain;

			//通过路径判断，该路径是否存在已开启了静态服务。
			//若存在，则标识并将域名指向添加到路由列表中；
			//若不存在，则将路径及域名信息放入到newQueue中
			if (path && domain) {
				if (staticPaths[path]) {
					staticPaths[path].enabled = true;
					routeList[domain] = staticPaths[path].port;
				} else {
					if (newQueue[path]) {
						newQueue[path].push(domain);
					} else {
						newQueue[path] = [domain];
						newQueue_num++;
					}
				}
			}
			//仅添加路由服务，需要指定域名和端口。
			if (item.onlyRoute) {
				routeList[domain] = item.port;
			}

		}

		clearNoneedServer();

		//开启新增的服务
		if (newQueue_num > 0) {
			for (path in newQueue) {
				startServer(path, function(result) {
					if (!result || result.err) {
						logger.warn("static-server start fail~! path: " + newQueue[i] + ", err: " + (result && result.err));
					} else {
						staticPaths[path] = result;

						for (i = 0; i < newQueue[path].length; i++) {
							routeList[newQueue[path][i]] = result.port;
						}
					}
					if (--newQueue_num === 0) {
						routeStart();
					}
				});
			}
		} else {
			routeStart();
		}
	} else {
		close();
	}

	//关闭清除不需要的服务
	function clearNoneedServer() {
		var _paths = {},
		k, item;
		for (k in staticPaths) {
			item = staticPaths[k];
			if (item.enabled) {
				delete item.enabled;
				_paths[k] = item;
			} else {
				close(item.server);
			}
		}
		staticPaths = _paths;
	}
}

//启动/重启 路由
function routeStart() {
	route.start(routeList);
}

/**
*@description 关闭服务
*@param server {Server} 需要关闭的服务 可选
*/
function close(server) {
	if (server) {
		server.close();
	} else {
		var ports = "";
		for (var k in staticPaths) {
			staticPaths[k].server.close();
			ports += staticPaths[k].port + ",";
		}
		staticPaths = {};

		var rlist = routeList;
		routeList = {};
		for (var k in rlist) {
			if (!new RegExp(rlist[k] + ",").test(ports)) {
				routeList[k] = rlist[k];
			}
		}
		routeStart();
	}
}

//退出进程
function exitProcess(msg) {
	if (exitProcess.ing) {
		return;
	}
	exitProcess.ing = true;
	logger.info('The vhosts process will be closed~! by ' + (msg || "exit"));

	route.exit();
	setTimeout(function() {
		logger.info("The vhosts process has exited~!");
		process.exit();
	},
	100);
}

/**
*@description vhosts入口方法
*/
function vhosts(type, options) {
	var fn = {
		"update": update,
		"exit": exitProcess
	};
	fn[type] && fn[type].apply(null, options);
}

process.on("message", function(m) {
	logger.debug("vhosts " + m.type);
	vhosts(m.type, m.options);
});

process.on('SIGINT', function() {
	exitProcess("SIGINT");
});

process.on('exit', function() {
	logger.debug("The vhosts process has exited~!~~~~~~~~~~~~~~~~~~`````");
});

// exports.vhosts = vhosts;

