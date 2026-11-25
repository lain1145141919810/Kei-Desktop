from kei_sdk import Context


def initialize(context: Context):
    def greet(arguments):
        name = str(arguments.get("name", context.config["name"]))[:60]
        context.emit("greeting.completed", {"name": name})
        return {"message": f"{name}さん、こんにちは。"}

    context.register("greet", greet)
