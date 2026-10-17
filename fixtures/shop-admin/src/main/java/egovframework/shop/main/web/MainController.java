package egovframework.shop.main.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

@Controller
public class MainController {

    @RequestMapping("/main.do")
    public String main() {
        return "shop/main";
    }

    @RequestMapping("/login.do")
    public String login() {
        return "shop/login";
    }
}
